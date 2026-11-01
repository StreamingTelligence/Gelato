# Rokid BOLON 眼镜原生示例

此无屏幕 Android 示例直接运行在眼镜上，使用 Gelato 共享协议客户端和眼镜本机的 Camera2 驱动。USB 调试线只用于首次安装、配对配置和可选维护；之后连接 Controller、每秒一帧摄像头画面和控制命令都走 Wi-Fi，不依赖手机伴侣端。

## 首次安装与配对

1. 让眼镜连上 Wi-Fi，再接通已授权的 USB 调试线。
2. 在仓库根目录执行 `node examples/device/rokid-native-app/scripts/commission.mjs --allow-control`。如果 ADB 同时连接多台设备，附加 `--serial 眼镜序列号`。脚本会检查 Android 版本和 Wi-Fi，构建及安装 APK，授予相机和麦克风权限，放行这款眼镜固件的后台 AppOps，并复核授权结果。`--allow-control` 表示明确同意配对后开启摄像头和麦克风推流；如果只想先配对、暂不上传媒体或允许远程控制，则省略。
3. 出现输入提示后，到 **Controller 私有控制台**选择 **Rokid BOLON glasses (native)**，生成一次性配对链接，并将完整的 `gelato://pair` 链接粘贴到终端。脚本不会回显链接；Controller 公网设备接入端口不提供控制台或管理员 API。
4. 等待终端输出 `Paired: dev_...`，再拔掉 USB。在私有控制台确认眼镜仍在线；若选择了 `--allow-control`，再确认摄像头帧序号持续增长，完成无线验收。

脚本把生成配对链接放在构建和安装**之后**，避免短效配对码在等待编译时过期。配对码不应写入源码、APK 或命令行；首次通过 ADB 传递配对码时，应信任用于安装的电脑。脚本需要交互终端和 Android platform-tools。已有 APK 时可使用 `--skip-build --apk /path/to/app.apk`。

升级已经配对的设备时，使用 `--update-only`，不加 `--allow-control`。该模式不生成新码、不更改所有者的控制授权；它在安装后重新放行后台 AppOps 并恢复原连接，因为实测这款眼镜固件会在 APK 更新时把后台权限重置为 `ignore`。如果应用已经安装，脚本默认拒绝再次配对；确实要重新配对时显式加 `--re-enroll`。覆盖安装 `adb install -r` 不清除既有配对凭据，解除配对或转移设备必须单独由设备所有者和 Controller 处理。

眼镜的相机采用连续预览，每秒上传一帧 JPEG。`camera.capture` 返回最近一帧，而非再次触发静态拍照。眼镜固件仍可能播放相机使用提示音。启用 Controller 的 Qwen Live Harness 集成后，眼镜还会上传 16 kHz 单声道 PCM16 麦克风音频，并在本机播放通过设备凭据鉴权、校验长度和 SHA-256 的 24 kHz 单声道 PCM16 回复。关闭允许接入会停止采集和播放，但不清除配对；音频在示例 Controller 中作为临时媒体消费，不保存为录音。可远程执行的命令仍只声明 `device.describe` 和 `camera.capture`；语音与摄像头观察不等于可执行命令。
