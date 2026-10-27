


        const connection = document.getElementById("connection");
        let lastReceived = null;

        function showStatus(text, healthy) {
            connection.textContent = text;
            connection.classList.toggle("healthy", healthy);
            document.body.classList.toggle("stale", !healthy);
            updateRecordButton();
        }

        function connect(){
            const protocol = location.protocol === "https:" ? "wss:" :"ws:";
            const socket = new WebSocket(protocol + "//" + location.host +"/ws");

            socket.onmessage = (event) => {
                const data = JSON.parse(event.data);
                lastReceived = performance.now();

                document.getElementById("x").textContent =
                    data.x_m === null ? "—" : data.x_m.toFixed(2);

                document.getElementById("y").textContent =
                    data.y_m === null ? "—" : data.y_m.toFixed(2);

                document.getElementById("speed").textContent = data.speed_mps !== null ? data.speed_mps.toFixed(3) : data.odom_state === "stale" ? "途絶" :"未取得";

                if (data.lidar && data.lidar.sensor === expectedLidar) expectedLidar = null;
                lastData = data;
                showStatus("サーバー接続中", true);
                document.getElementById("pose-state").textContent =
                    stateLabel(data.pose_state);
                document.getElementById("odom-state").textContent =
                    stateLabel(data.odom_state);
                document.getElementById("map-state").textContent =
                    data.frame_id ? "座標系: " + data.frame_id : "位置受信待機中";
                const now = performance.now() / 1000;
                speedHistory.push({t: now, value: data.speed_mps});
                speedHistory = speedHistory.filter(p => p.t >= now - 60);
                if (data.pose_state === "receiving" &&
                    Number.isFinite(data.x_m) && Number.isFinite(data.y_m)) {
                    const previous = track[track.length - 1];
                    if (previous && previous.frame !== data.frame_id) track = [];
                    if (!previous || previous.x !== data.x_m || previous.y !== data.y_m || previous.frame !== data.frame_id) {
                        track.push({x:data.x_m, y:data.y_m, frame:data.frame_id});
                        if (track.length > 3000) track.shift();
                    }
                }
                updateAlerts();
                drawViews();
            };
            socket.onerror = () => socket.close();
            socket.onclose = () => {
                lastReceived = null;
                showStatus("切断・再接続中", false);
                updateAlerts();
                drawLidar();
                setTimeout(connect, 2000);
            };
        }

        setInterval(() => {
            if(
                lastReceived !== null &&
                performance.now() - lastReceived > 3000
            ){
                showStatus("サーバー応答なし",false);
                updateAlerts();
            }
        },500);

        let lidarSwitching = false;
        let coordinateSaving = false;
        let expectedLidar = null;
        let lidarError = "";
        let lastData = null;
        let track = [];
        let speedHistory = [];
        const stateLabel = state => ({receiving:"受信中", waiting:"待機中", stale:"-"}[state] || "未取得");
        connect();

        const refreshTopicsButton = document.getElementById("refresh-topics");
        const topicsStatus = document.getElementById("topics-status");
        const topicsBody = document.getElementById("topics-body");

        async function refreshTopics() {
            if (!refreshTopicsButton || !topicsStatus || !topicsBody) {
                return;
            }

            refreshTopicsButton.disabled = true;
            topicsStatus.textContent = "取得中…";

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);

            try {
                const response = await fetch("/api/topics", {
                    cache: "no-store",
                    signal: controller.signal
                });

                if (!response.ok) {
                    throw new Error("HTTP " + response.status);
                }

                const data = await response.json();
                if (!Array.isArray(data.topics)) {
                    throw new Error("Topic一覧の応答形式が不正です");
                }

                const rows = [];

                for (const topic of data.topics) {
                    const row = document.createElement("tr");
                    const values = [
                        topic.name,
                        topic.types.join(", "),
                        topic.publisher_count
                    ];

                    for (const value of values) {
                        const cell = document.createElement("td");
                        cell.textContent = String(value);
                        row.appendChild(cell);
                    }

                    const actionCell = document.createElement("td");
                    const selectButton = document.createElement("button");
                    selectButton.type = "button";
                    selectButton.textContent = "選択";
                    selectButton.addEventListener("click", () => {
                        document.getElementById("selected-topic").textContent =
                            "選択中のTopic：" + topic.name +
                            " / 型：" + topic.types.join(", ");
                    });
                    actionCell.appendChild(selectButton);
                    row.appendChild(actionCell);
                    rows.push(row);
                }

                topicsBody.replaceChildren(...rows);
                topicsStatus.textContent =
                    data.topics.length + " 件 / 更新: " +
                    new Date().toLocaleTimeString();

            } catch (error) {
                const message = error.name === "AbortError"
                    ? "10秒以内に応答がありませんでした"
                    : error.message;
                topicsStatus.textContent =
                    "取得失敗（一覧は更新されていません）: " + message;

            } finally {
                clearTimeout(timeout);
                refreshTopicsButton.disabled = false;
            }
        }

        // 一覧用HTMLを追加した後にボタンを有効にする。
        if (refreshTopicsButton && topicsStatus && topicsBody) {
            refreshTopicsButton.addEventListener("click", refreshTopics);

        }

        // Coordinate recording: the server snapshots its current ROS pose.
        function updateRecordButton() {
            const available = lastData && lastData.pose_state === "receiving" &&
                !document.body.classList.contains("stale");
            const button = document.getElementById("record-coordinate");
            button.disabled = coordinateSaving || !available;
            button.textContent = coordinateSaving ? "保存中…" : "座標を記録";
        }

        async function recordCoordinate() {
            const button = document.getElementById("record-coordinate");
            if (button.disabled) return;
            coordinateSaving = true;
            updateRecordButton();
            const result = document.getElementById("coordinate-result");
            result.classList.remove("error");
            result.textContent = "サーバーへ保存を要求しています…";
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 10000);
            try {
                // Do not send browser coordinates: they may already be out of date.
                const response = await fetch("/api/waypoints", {
                    method: "POST",
                    signal: controller.signal
                });
                if (!response.ok) {
                    if (response.status === 404) {
                        throw new Error("Python側の /api/waypoints が未実装です。追加後にサーバーを再起動してください。");
                    }
                    const data = await response.json();
                    throw new Error(typeof data.detail === "string" ? data.detail : "HTTP " + response.status);
                }
                const data = await response.json();
                if (!Number.isFinite(data.x) || !Number.isFinite(data.y)) {
                    throw new Error("保存結果の応答形式が違います。Python側の戻り値を確認してください。");
                }
                result.textContent = "保存済み · X: " + data.x.toFixed(3) +
                    " m / Y: " + data.y.toFixed(3) + " m";
            } catch (error) {
                result.classList.add("error");
                result.textContent = error.name === "AbortError" || error instanceof TypeError
                    ? "保存結果を確認できませんでした。保存済みの可能性もあるため、記録ファイルを確認してください。"
                    : "保存失敗: " + error.message;
            } finally {
                clearTimeout(timer);
                coordinateSaving = false;
                updateRecordButton();
            }
        }
        document.getElementById("record-coordinate").addEventListener("click", recordCoordinate);

        // Rendering uses the existing WebSocket data; no ROS subscription changes.
        function canvasContext(id) {
            const canvas = document.getElementById(id);
            const rect = canvas.getBoundingClientRect();
            const ratio = window.devicePixelRatio || 1;
            canvas.width = Math.round(rect.width * ratio);
            canvas.height = Math.round(rect.height * ratio);
            const ctx = canvas.getContext("2d");
            ctx.scale(ratio, ratio);
            return {ctx, w:rect.width, h:rect.height};
        }
        function drawTrack() {
            const {ctx, w, h} = canvasContext("map-canvas");
            ctx.fillStyle = "#f4f7f8"; ctx.fillRect(0,0,w,h);
            ctx.strokeStyle = "#e1e8ec"; ctx.lineWidth = 1;
            for (let x=0; x<w; x+=32) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); }
            for (let y=0; y<h; y+=32) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }
            if (!track.length) {
                ctx.fillStyle = "#788897"; ctx.font = "14px sans-serif";
                ctx.fillText("位置データを待っています",24,40); return;
            }
            let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
            for (const p of track) { minX=Math.min(minX,p.x); maxX=Math.max(maxX,p.x); minY=Math.min(minY,p.y); maxY=Math.max(maxY,p.y); }
            const scale = Math.min((w-64)/Math.max(maxX-minX,10), (h-64)/Math.max(maxY-minY,10));
            const point = p => [w/2+(p.x-(minX+maxX)/2)*scale, h/2-(p.y-(minY+maxY)/2)*scale];
            if (document.getElementById("show-track").checked) {
                ctx.beginPath(); ctx.strokeStyle="#268bdf"; ctx.lineWidth=3;
                track.forEach((p,i) => { const [x,y]=point(p); i ? ctx.lineTo(x,y) : ctx.moveTo(x,y); }); ctx.stroke();
            }
            const [x,y] = point(track[track.length-1]);
            const live = lastData && lastData.pose_state === "receiving" && !document.body.classList.contains("stale");
            ctx.beginPath(); ctx.arc(x,y,17,0,Math.PI*2); ctx.fillStyle=live?"#d7f1e5":"#e5e9ed"; ctx.fill();
            ctx.beginPath(); ctx.arc(x,y,8,0,Math.PI*2); ctx.fillStyle=live?"#149c70":"#8795a3"; ctx.fill();
            ctx.strokeStyle="white"; ctx.lineWidth=3; ctx.stroke();
            ctx.fillStyle="#607586"; ctx.font="12px sans-serif";
            ctx.fillText("X → / Y ↑ · 自動縮尺 · 最後の受信位置",16,h-16);
        }
        function drawSpeed() {
            const {ctx,w,h} = canvasContext("speed-canvas");
            const left=48,right=w-16,top=20,bottom=h-28;
            const now=performance.now()/1000;
            const points=speedHistory.filter(p=>p.t>=now-60);
            const values=points.filter(p=>Number.isFinite(p.value)).map(p=>p.value);
            const min=Math.min(0,...values)-0.1,max=Math.max(0.5,...values)+0.1;
            const y=v=>bottom-(v-min)/(max-min)*(bottom-top);
            ctx.font="11px sans-serif";
            for(let i=0;i<=3;i++) {
                const value=min+(max-min)*i/3,py=y(value);
                ctx.strokeStyle="#e7edf1";ctx.beginPath();ctx.moveTo(left,py);ctx.lineTo(right,py);ctx.stroke();
                ctx.fillStyle="#758594";ctx.fillText(value.toFixed(2),4,py+4);
            }
            ctx.strokeStyle="#2788db";ctx.lineWidth=2;ctx.beginPath();
            let previous=null;
            for(const p of points) {
                if(!Number.isFinite(p.value)) { previous=null; continue; }
                const px=left+(p.t-(now-60))/60*(right-left),py=y(p.value);
                if(previous && p.t-previous.t<1) ctx.lineTo(px,py); else ctx.moveTo(px,py);
                previous=p;
            }
            ctx.stroke();ctx.fillStyle="#758594";
            ctx.fillText("−60秒",left,h-7);ctx.fillText("現在",right-25,h-7);
        }
        // LiDAR uses sensor coordinates: +X up, +Y left. No TF transform.
        function drawLidar() {
            const {ctx,w,h} = canvasContext("lidar-canvas");
            const lidar = lastData && lastData.lidar;
            const disconnected = document.body.classList.contains("stale");
            const switching = lidarSwitching || (expectedLidar && (!lidar || lidar.sensor !== expectedLidar));
            const range = lidar && Number.isFinite(lidar.range_m) && lidar.range_m > 0 ? lidar.range_m : 20;
            const radius = Math.max(1, Math.min(w-64,h-36)/2);
            const cx=w/2, cy=h/2, scale=radius/range;
            ctx.fillStyle="#f8fbfd";ctx.fillRect(0,0,w,h);
            ctx.strokeStyle="#dce7ee";ctx.lineWidth=1;
            for(const fraction of [.5,1]) {
                ctx.beginPath();ctx.arc(cx,cy,radius*fraction,0,Math.PI*2);ctx.stroke();
            }
            ctx.beginPath();ctx.moveTo(cx-radius,cy);ctx.lineTo(cx+radius,cy);
            ctx.moveTo(cx,cy-radius);ctx.lineTo(cx,cy+radius);ctx.stroke();
            const receiving = lidar && lidar.state === "receiving" && !disconnected && !switching;
            let count=0;
            if(receiving && Array.isArray(lidar.points)) {
                ctx.fillStyle="#2584d4";
                for(const point of lidar.points) {
                    if(!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
                    const [x,y]=point;
                    if(x*x+y*y>range*range) continue;
                    ctx.fillRect(cx-y*scale-1,cy-x*scale-1,2,2);count++;
                }
            }
            ctx.fillStyle=receiving?"#16966d":"#93a4b1";
            ctx.beginPath();ctx.moveTo(cx,cy-6);ctx.lineTo(cx-5,cy+5);ctx.lineTo(cx+5,cy+5);ctx.closePath();ctx.fill();
            ctx.fillStyle="#738697";ctx.font="11px sans-serif";
            ctx.fillText("X ↑ / Y ←",10,16);
            ctx.fillText("半径 " + range + " m",10,h-8);
            let state = !lidar ? "未連携" : stateLabel(lidar.state);
            if(disconnected) state="サーバー未接続";
            if(switching) state="切り替え待機中";
            document.getElementById("lidar-state").textContent=state;
            const name=lidar && lidar.sensor === "livox"?"Livox":"Velodyne";
            const info=lidar ? name+" · "+state+" · "+count+"点 / 座標系: "+(lidar.frame_id || "未取得") : "LiDARデータ未連携";
            document.getElementById("lidar-info").textContent=lidarError || info;
            const select=document.getElementById("lidar-select");
            select.disabled=disconnected || !lidar || switching;
            if(lidar && !switching && ["velodyne","livox"].includes(lidar.sensor)) select.value=lidar.sensor;
            if(!receiving) {
                ctx.fillStyle="#738697";ctx.textAlign="center";
                ctx.fillText(state,cx,cy+24);ctx.textAlign="left";
            }
        }
        async function selectLidar() {
            const select=document.getElementById("lidar-select");
            const sensor=select.value;
            expectedLidar=sensor;lidarSwitching=true;lidarError="";
            drawLidar();
            const controller=new AbortController();
            const timer=setTimeout(()=>controller.abort(),10000);
            try {
                const response=await fetch("/api/lidar/select",{
                    method:"POST",headers:{"Content-Type":"application/json"},
                    body:JSON.stringify({sensor}),signal:controller.signal
                });
                const data=await response.json();
                if(!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "HTTP "+response.status);
                // The next WebSocket message confirms which sensor is active.
            } catch(error) {
                expectedLidar=null;
                lidarError="切り替え失敗: "+(error.name === "AbortError" ? "10秒以内に応答がありません。Python側を確認してください。" : error.message);
            } finally {
                clearTimeout(timer);lidarSwitching=false;drawLidar();
            }
        }
        document.getElementById("lidar-select").addEventListener("change",selectLidar);
        function drawViews() { drawTrack(); drawSpeed(); drawLidar(); }
        function updateAlerts() {
            const list=document.getElementById("alerts"); list.replaceChildren();
            const messages=[];
            if(document.body.classList.contains("stale")) messages.push("サーバー接続または応答を確認してください。");
            if(lastData && lastData.pose_state==="stale") messages.push("/pcl_pose との接続が切れています。");
            if(lastData && lastData.odom_state==="stale") messages.push("/odom との接続が切れています。。");
            if(lastData && lastData.lidar && lastData.lidar.state==="stale") messages.push(lastData.lidar.topic+" との接続が切れています。");
            if(!messages.length) messages.push(lastData?"受信データは正常です。":"データ受信待機中です。");
            messages.push("/diagnostics 未連携：機体全体の正常性は未判定です。");
            for(const text of messages) { const li=document.createElement("li");li.textContent=text;list.append(li); }
        }
        document.getElementById("show-track").addEventListener("change",drawTrack);
        document.getElementById("clear-track").addEventListener("click",()=>{track=[];drawTrack();});
        window.addEventListener("resize",drawViews);
        setInterval(()=>{
            document.getElementById("clock").textContent=new Date().toLocaleTimeString("ja-JP");
            drawViews();
        },1000);
        document.getElementById("clock").textContent=new Date().toLocaleTimeString("ja-JP");
        drawViews(); updateAlerts();
