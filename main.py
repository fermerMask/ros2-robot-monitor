import asyncio
from logging import lastResort
from sys import excepthook
import time
from pathlib import Path
import threading
from contextlib import asynccontextmanager

import rclpy
from rclpy.executors import SingleThreadedExecutor
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from geometry_msgs.msg import PoseWithCovarianceStamped
from nav_msgs.msg import Odometry
from fastapi import FastAPI, WebSocket, WebSocketDisconnect,HTTPException
from fastapi.responses import FileResponse

from pydantic import BaseModel
import math
from itertools import islice
from sensor_msgs.msg import PointCloud2
from sensor_msgs_py import point_cloud2

import csv
from datetime import datetime
from uuid import uuid4

BASE_DIR = Path(__file__).resolve().parent
LIDAR_TOPICS = {
    "velodyne":"/velodyne_points",
    "livox": "/livox/lidar",
}
class LidarSelection(BaseModel):
    sensor: str


class PoseMonitor(Node):
    def __init__(self):
        super().__init__("web_status_monitor")
        self.lock = threading.Lock()
        self.latest = None
        self.last_received = None
        self.subscription = self.create_subscription(
            PoseWithCovarianceStamped, "/pcl_pose", self.on_pose,
            qos_profile_sensor_data,
        )
        self.speed_mps = None
        self.odom_received = None
        self.odom_subscription = self.create_subscription(
            Odometry, "/odom", self.on_odom, qos_profile_sensor_data,
        )
        self.lidar_subscription = None
        self.lidar_sensor = None
        self.lidar_points = []
        self.lidar_frame = None
        self.lidar_received = None
        self.lidar_processed = None

        self.lidar_generation = 0
        self.select_lidar("velodyne")

    def on_pose(self, msg):
        with self.lock:
            self.latest = {
                "x_m": msg.pose.pose.position.x,
                "y_m": msg.pose.pose.position.y,
                "frame_id": msg.header.frame_id,
            }
            self.last_received = time.monotonic()

    def on_odom(self, msg):
        with self.lock:
            self.speed_mps = msg.twist.twist.linear.x
            self.odom_received = time.monotonic()

    def list_topics(self):
        topics = []
        for name, types in self.get_topic_names_and_types():
            topics.append({
                "name": name,
                "types": types,
                "publisher_count": self.count_publishers(name),
            })
        return sorted(topics, key=lambda topic: topic["name"])

    def select_lidar(self,sensor):
        if sensor not in LIDAR_TOPICS:
            raise ValueError("velodyneまたはlivoxを指定してください")

        with self.lock:
            if sensor == self.lidar_sensor:
                return

            generation = self.lidar_generation + 1

            subscription = self.create_subscription(
                PointCloud2,
                LIDAR_TOPICS[sensor],
                lambda msg: self.on_lidar(msg, generation),
                qos_profile_sensor_data,
            )
            old_subscription = self.lidar_subscription
            self.lidar_subscription = subscription
            self.lidar_generation = generation
            self.lidar_sensor = sensor

            self.lidar_points = []
            self.lidar_frame = None
            self.lidar_received = None
            self.lidar_processed = None

        if old_subscription is not None:
            self.destroy_subscription(old_subscription)

    def on_lidar(self, msg, generation):
        now = time.monotonic()

        with self.lock:
            if generation != self.lidar_generation:
                return
            if (self.lidar_processed is not None
                and now - self.lidar_processed < 0.2):
                    return

            self.lidar_processed = now

        max_points = 1000
        range_m = 20.0
        total = msg.width * msg.height
        step = max(1,math.ceil(total/max_points))

        source = point_cloud2.read_points(
            msg,
            field_names=("x", "y","z"),
            skip_nans=True,
        )
        points = []

        for point in islice(source,0,None,step):
            x,y,z = map(float,point)

            if not all(math.isfinite(v) for v in (x,y,z)):
                continue
            if x*x + y*y > range_m * range_m:
                continue
            points.append([round(x,3),round(y,3)])

            if len(points) >= max_points:
                break

        with self.lock:
            if generation != self.lidar_generation:
                return

            self.lidar_points = points
            self.lidar_frame = msg.header.frame_id
            self.lidar_received = now

    def record_waypoint(self):
        with self.lock:
            if self.latest is None or self.last_received is None:
                raise ValueError("位置データをまだ受信していません。")

            age = time.monotonic() - self.last_received

            if age >= 2.0:
                raise ValueError("位置データが途絶しているため記録できません。")

            x = self.latest["x_m"]
            y = self.latest["y_m"]

            if not all(math.isfinite(value) for value in (x,y)):
                raise ValueError("座標に無効な値があります")

            directory = BASE_DIR / "records"
            directory.mkdir(parents=True, exist_ok=True)

            destination = directory / "waypoint.csv"
            needs_header = (
                not destination.exists()
                or destination.stat().st_size == 0
            )
            with destination.open(
                "a",newline="",encoding="utf-8"
            ) as file:
                writer = csv.writer(file)

                if needs_header:
                    writer.writerow([x,y])

                writer.writerow([x,y])

            return {"x":x, "y":y}




    def snapshot(self):
        with self.lock:
            now = time.monotonic()
            pose_age = (
                None if self.last_received is None
                else now - self.last_received
            )
            odom_age = (
                None if self.odom_received is None
                else now - self.odom_received
            )
            pose_state = (
                "waiting" if pose_age is None
                else "receiving" if pose_age < 2.0 else "stale"
            )
            odom_state = (
                "waiting" if odom_age is None
                else "receiving" if odom_age < 2.0 else "stale"
            )
            lidar_age = (
                None if self.lidar_received is None
                else now - self.lidar_received
            )
            lidar_state = (
                "waiting" if lidar_age is None
                else "receiving" if lidar_age < 2.0
                else "stale"
            )


            return {
                "x_m": None if self.latest is None else self.latest["x_m"],
                "y_m": None if self.latest is None else self.latest["y_m"],
                "frame_id": None if self.latest is None else self.latest["frame_id"],
                "pose_state": pose_state,
                "age_s": None if pose_age is None else round(pose_age, 1),
                "speed_mps": self.speed_mps if odom_state == "receiving" else None,
                "odom_state": odom_state,
                "lidar": {
                    "sensor":self.lidar_sensor,
                    "topic": LIDAR_TOPICS[self.lidar_sensor],
                    "frame_id":self.lidar_frame,
                    "points":(
                        self.lidar_points
                        if lidar_state == "receiving"
                        else []
                    ),
                    "state": lidar_state,
                    "age_s":(
                        None if lidar_age is None
                        else round(lidar_age,1)
                    ),
                    "range_m":20.0
                }
            }


@asynccontextmanager
async def lifespan(app):
    rclpy.init(args=[])
    monitor = PoseMonitor()
    executor = SingleThreadedExecutor()
    executor.add_node(monitor)
    thread = threading.Thread(target=executor.spin, daemon=True)
    thread.start()
    app.state.monitor = monitor
    try:
        yield
    finally:
        executor.shutdown()
        thread.join()
        monitor.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


app = FastAPI(lifespan=lifespan)


@app.get("/")
async def index():
    return FileResponse(BASE_DIR / "index.html")


@app.websocket("/ws")
async def stream_status(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            await websocket.send_json(app.state.monitor.snapshot())
            await asyncio.sleep(0.2)
    except WebSocketDisconnect:
        pass


@app.get("/api/topics")
def get_topics():
    return {"topics": app.state.monitor.list_topics()}


@app.post("/api/lidar/select")
def select_lidar(selection: LidarSelection):
    try:
        app.state.monitor.select_lidar(selection.sensor)
    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from error

    return {
        "sensor":selection.sensor,
        "topic":LIDAR_TOPICS[selection.sensor],
    }

@app.post("/api/waypoints")
def record_waypoint():
    try:
        return app.state.monitor.record_waypoint()

    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from error
    except OSError as error:
        raise HTTPException(
            status_code=500,
            detail="座標をファイルに保存できません",
        )from error
