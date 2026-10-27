# TSUKUBA AMR OPERATIONS

つくばチャレンジ向けに開発中のROS 2監視Webアプリです。
PythonでROSデータを受信し、同一ネットワークのPC・iPadのブラウザへ配信します。

開発者自身がコードを理解しながら段階的に実装する方針です。
HTML・CSS・JavaScriptとPython / FastAPI / rclpyの構成を維持します。

## 現在の機能

- `/pcl_pose` のX・Y表示とローカル座標での走行軌跡
- `/odom` の前後速度と直近60秒のグラフ
- Velodyne / Livoxの切り替えとセンサー中心の2D点群表示
- Topic名・メッセージ型・Publisher数の一覧とTopicの選択表示
- 現在位置のX・YをCSVへ追記
- サーバー接続・データ途絶の表示、自動再接続

背景地図、GNSS、RTK状態、Nav2状態、指令速度、バッテリー、診断Topicの連携は未実装です。
Topic一覧での選択は名前と型の確認のみで、各パネルの購読先を変更しません。

## 構成

```text
main.py           ROS購読・FastAPI・WebSocket・CSV保存
index.html        画面・CSS・JavaScript・Canvas描画
requirements.txt  Pythonの直接依存バージョン
records/          実行時に生成する座標記録（Git管理対象外）
```

## 開発環境

- Ubuntu 22.04 / ROS 2 Humble / Python 3.10を想定
- ROS環境を読み込み、ROS側のPythonパッケージを参照できる仮想環境を使用
- Python依存は `requirements.txt` の版を使用。推移依存を含む完全なロックファイルではありません。

2026-10-27に開発PCで確認したROSパッケージ:

| パッケージ | インストール版 |
|---|---|
| ros-humble-rclpy | 3.3.19-1jammy.20251118.151334 |
| ros-humble-sensor-msgs-py | 4.9.0-1jammy.20251108.035715 |
| ros-humble-septentrio-gnss-driver | 未導入 |

Jetsonへの配置時にはOS・ROS・Pythonの互換性を確認してください。
Septentrio mosaic-Hは公式ドライバーを使う予定ですが、JetsonとPCで合わせる版はまだ決定していません。
ROSパッケージのバイナリ版はCPU構成によって異なるため、必要に応じてソースの同一タグ・コミットを基準に合わせます。

## セットアップ

ROS 2 Humbleと必要なメッセージパッケージが導入済みの環境で実行します。
ドライバーやROS本体をpipでインストールする構成ではありません。

```bash
cd /path/to/status-monitor
source /opt/ros/humble/setup.bash
/usr/bin/python3 -m venv --system-site-packages .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

仮想環境は各PC・Jetsonで個別に作成し、Gitで共有しません。

## 起動

```bash
cd /path/to/status-monitor
source /opt/ros/humble/setup.bash
source .venv/bin/activate
python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

- PC: `http://127.0.0.1:8000`
- iPad: 同じWi-Fiにつなぎ、`http://PCのIPアドレス:8000`
- 停止: サーバーのターミナルで `Ctrl+C`
- HTML変更の反映: ブラウザを強制再読み込み
- Python変更の反映: サーバー再起動

認証なしのローカル監視用試作です。信頼できるネットワーク内で使用します。

## bagでの動作確認

別のターミナルで、必要なTopicだけを再生します。

```bash
source /opt/ros/humble/setup.bash
ros2 bag play /path/to/20261017-3_0.db3 \
  --topics /pcl_pose /odom /velodyne_points /livox/lidar
```

`--rate 10` で10倍速にできますが、Web配信は約5Hzのため、記録時刻で約2秒おきの表示になります。
`/cmd_vel` などの走行指令Topicは、この確認では再生しません。

## 座標記録

位置受信中に「座標を記録」を押すと、サーバー側の最新X・Yを `records/waypoint.csv` に追記します。
座標は `/pcl_pose` の座標系の値で、緯度経度ではありません。
受信から2秒以上経過した位置は保存しません。

CSV、bag、点群、仮想環境はGitへ追加しません。実測データのバックアップは別途行います。

## API

| エンドポイント | 用途 |
|---|---|
| `GET /` | 画面 |
| `GET /api/topics` | Topic一覧 |
| `POST /api/lidar/select` | `{"sensor":"velodyne"}` または `{"sensor":"livox"}` で選択 |
| `POST /api/waypoints` | 最新のX・Yを保存し、`{"x":数値,"y":数値}` を返す |
| WebSocket `/ws` | 座標・速度・LiDAR・受信状態を約0.2秒ごとに配信 |

LiDARの選択はサーバーで共有され、接続中の全端末へ反映されます。

## 現時点の確認事項

- 走行軌跡の中心と縮尺は自動で変わります。地図へ固定した表示は今後の改善対象です。
- LiDARはセンサー座標で描画し、ロボット基準点へのTF変換や地面除去は行いません。
- CSV初回作成時に見出しの代わりに座標値を書き、最初の値が重複する箇所が残っています。
  `if needs_header:` 内を `writer.writerow(["x", "y"])` にする修正候補です。
  今回はGit管理の準備だけを行い、アプリの処理は変更していません。

## Gitの使い方

このディレクトリは独立したリポジトリです。操作前にここへ移動します。

```bash
cd /path/to/status-monitor
git status
git diff
git add main.py index.html
git commit -m "Describe the change"
```

GitHubなどのリモートは未設定です。配置先を決めてから追加します。
Jetsonでは同じコミットを取得して実行することで、実行版を一致させられます。
