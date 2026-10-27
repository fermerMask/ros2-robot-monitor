import asyncio
import threading
from contextlib import asynccontextmanager
from pathlib import Path

import rclpy
from fastapi import (
    FastAPI,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from rclpy.executors import SingleThreadedExecutor

from ros_monitor import PoseMonitor, LIDAR_TOPICS


BASE_DIR = Path(__file__).resolve().parent

class LidarSelection(BaseModel):
    sensor: str

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
app.mount("/static",StaticFiles(directory=BASE_DIR/"static"))

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
