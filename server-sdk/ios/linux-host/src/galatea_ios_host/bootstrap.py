from __future__ import annotations

import asyncio
import hashlib
import html
import json
import os
import re
import secrets
import shutil
import stat
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from aiohttp import web

from .constants import DEFAULT_AGENT_BUNDLE_ID
from .enrollment import UDID_PATTERN, _atomic_private_json


XCODE_27_PATTERN = r"(?i)^Xcode 27(?:[ .]|$).*\.xip$"
TWO_FACTOR_PATTERN = re.compile(r"^[0-9]{6}$")
EMAIL_PATTERN = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+")
TOKEN_PATTERN = re.compile(r"(?<![A-Za-z0-9])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9])")


def _private_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)


def _redact(value: str) -> str:
    value = EMAIL_PATTERN.sub("[account redacted]", value)
    return TOKEN_PATTERN.sub("[secret redacted]", value)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _subprocess_umask() -> None:
    os.umask(0o077)


@dataclass(frozen=True)
class BootstrapConfig:
    state_dir: Path
    xtool: Path
    ipsw: Path
    swift: Path
    project_dir: Path
    build_script: Path
    enrollment_record: Path
    toolset_archive: Path
    toolset_sha256: str
    bundle_id: str = DEFAULT_AGENT_BUNDLE_ID

    @property
    def private_home(self) -> Path:
        return self.state_dir / "private" / "apple-home"

    @property
    def artifacts_dir(self) -> Path:
        return self.state_dir / "artifacts"

    @property
    def xcode_dir(self) -> Path:
        return self.artifacts_dir / "xcode"

    @property
    def sdk_dir(self) -> Path:
        return self.artifacts_dir / "darwin-sdk"

    @property
    def ipa_path(self) -> Path:
        return self.artifacts_dir / "MobileAgent.ipa"

    def validate(self) -> None:
        for path, label in (
            (self.xtool, "xtool"),
            (self.ipsw, "ipsw"),
            (self.swift, "Swift"),
            (self.build_script, "iOS build script"),
            (self.toolset_archive, "Darwin toolset archive"),
        ):
            if not path.is_file():
                raise ValueError(f"{label} is missing")
        if not self.project_dir.is_dir():
            raise ValueError("iOS project directory is missing")
        if not re.fullmatch(r"[a-fA-F0-9]{64}", self.toolset_sha256):
            raise ValueError("Darwin toolset SHA-256 is invalid")
        actual = _sha256_file(self.toolset_archive)
        if not secrets.compare_digest(actual, self.toolset_sha256.lower()):
            raise ValueError("Darwin toolset archive checksum does not match")


class BootstrapManager:
    def __init__(self, config: BootstrapConfig) -> None:
        config.validate()
        self.config = config
        for directory in (
            config.state_dir,
            config.state_dir / "private",
            config.private_home,
            config.artifacts_dir,
            config.xcode_dir,
        ):
            _private_directory(directory)
        self.phase = "idle"
        self.detail = "等待 Apple 账户登录"
        self.error: str | None = None
        self.selected_download: dict[str, Any] | None = None
        self.ipa_sha256: str | None = None
        self.started_at: float | None = None
        self.updated_at = time.time()
        self._task: asyncio.Task[None] | None = None
        self._process: asyncio.subprocess.Process | None = None
        self._response_kind: str | None = None
        self._stderr_tail = ""
        self._attempts: list[float] = []
        self._restore_completed_state()
        self._persist()

    def status(self) -> dict[str, Any]:
        return {
            "phase": self.phase,
            "detail": self.detail,
            "error": self.error,
            "selectedDownload": self.selected_download,
            "busy": self._task is not None and not self._task.done(),
            "needsSecondFactor": self._response_kind == "2fa",
            "needsPhone": self._response_kind == "phone",
            "phones": self.selected_download.get("phones", [])
            if self._response_kind == "phone" and self.selected_download
            else [],
            "complete": self.phase == "complete",
            "updatedAt": self.updated_at,
        }

    def command_preview(self) -> list[list[str]]:
        return [
            [
                str(self.config.xtool),
                "auth",
                "login",
                "--mode",
                "password",
                "--prefer-paid-team",
                "--credentials-stdin",
                "--reuse-existing",
                "--quiet",
            ],
            [
                str(self.config.ipsw),
                "download",
                "dev",
                "--more",
                "--credentials-stdin",
                "--automation-quiet",
                "--latest-matching",
                XCODE_27_PATTERN,
                "--output",
                str(self.config.xcode_dir),
            ],
        ]

    async def start(self, username: str, password: str) -> None:
        if self._task is not None and not self._task.done():
            raise ValueError("配置流程正在运行")
        now = time.monotonic()
        self._attempts = [attempt for attempt in self._attempts if now - attempt < 900]
        if len(self._attempts) >= 3:
            raise ValueError("登录尝试过于频繁，请稍后重试")
        username = username.strip()
        if not username or not password:
            raise ValueError("请输入 Apple 账户和密码")
        if len(username) > 320 or len(password) > 1024:
            raise ValueError("账户凭据格式无效")
        self._attempts.append(now)
        self.started_at = time.time()
        self.error = None
        self.selected_download = None
        self._stderr_tail = ""
        self._task = asyncio.create_task(self._pipeline(username, password))

    async def submit_second_factor(self, code: str) -> None:
        if self._response_kind != "2fa" or self._process is None:
            raise ValueError("当前没有等待验证码")
        code = code.strip()
        if not TWO_FACTOR_PATTERN.fullmatch(code):
            raise ValueError("请输入 6 位验证码")
        await self._write_process_input(
            json.dumps({"code": code})
            if self.phase == "downloading_xcode_2fa"
            else code
        )
        self._response_kind = None
        self._set_phase(
            "downloading_xcode"
            if self.phase == "downloading_xcode_2fa"
            else "signing_login",
            "正在验证 Apple 账户",
        )

    async def submit_phone(self, index: int) -> None:
        if self._response_kind != "phone" or self._process is None:
            raise ValueError("当前没有等待号码选择")
        phones = (
            self.selected_download.get("phones", []) if self.selected_download else []
        )
        if not isinstance(index, int) or index < 0 or index >= len(phones):
            raise ValueError("请选择有效的受信任号码")
        await self._write_process_input(json.dumps({"phoneIndex": index}))
        self._response_kind = None
        self._set_phase("downloading_xcode", "正在发送验证码")

    async def close(self) -> None:
        if self._task is not None and not self._task.done():
            self._task.cancel()
        if self._process is not None and self._process.returncode is None:
            self._process.terminate()
            try:
                await asyncio.wait_for(self._process.wait(), timeout=5)
            except asyncio.TimeoutError:
                self._process.kill()
                await self._process.wait()

    async def _pipeline(self, username: str, password: str) -> None:
        credentials = json.dumps(
            {"username": username, "password": password}, separators=(",", ":")
        )
        try:
            self._set_phase("signing_login", "正在登录开发者签名服务")
            await self._run_xtool_login(credentials)
            self._verify_xtool_token_permissions()

            self._set_phase("downloading_xcode", "正在从 Apple 获取 Xcode 27")
            await self._run_ipsw_download(credentials)
            credentials = ""
            username = ""
            password = ""

            xcode = self._single_xcode_archive()
            self._set_phase("building_sdk", "正在生成 Darwin Swift SDK")
            shutil.rmtree(self.config.sdk_dir, ignore_errors=True)
            _private_directory(self.config.sdk_dir)
            await self._run_command(
                [
                    str(self.config.xtool),
                    "sdk",
                    "build",
                    str(xcode),
                    str(self.config.sdk_dir),
                ],
                env={
                    "XTOOL_DARWIN_TOOLSET_ARCHIVE": str(self.config.toolset_archive),
                    "XTOOL_DARWIN_TOOLSET_SHA256": self.config.toolset_sha256,
                },
            )
            sdk = self._single_sdk_bundle()
            self._set_phase("installing_sdk", "正在安装 Darwin Swift SDK")
            await self._run_command(
                [str(self.config.xtool), "sdk", "install", str(sdk)]
            )

            device = self._verified_device_record()
            self._set_phase("registering_device", "正在登记网络设备")
            await self._run_command(
                [
                    str(self.config.xtool),
                    "ds",
                    "devices",
                    "add",
                    "--udid",
                    device["udid"],
                    "--name",
                    device.get("deviceName") or "Serverized iOS Device",
                ]
            )

            self._set_phase("building_ipa", "正在签名并校验 Gelato iOS App")
            await self._run_command(
                [str(self.config.build_script), str(self.config.project_dir)],
                env={"XTOOL_BIN": str(self.config.xtool)},
            )
            source_ipa = self.config.project_dir / "xtool" / "MobileAgent.ipa"
            if not source_ipa.is_file() or source_ipa.stat().st_size == 0:
                raise RuntimeError("签名安装包未生成")
            temporary_ipa = self.config.ipa_path.with_suffix(".ipa.tmp")
            temporary_ipa.write_bytes(source_ipa.read_bytes())
            temporary_ipa.chmod(0o600)
            temporary_ipa.replace(self.config.ipa_path)
            self.ipa_sha256 = _sha256_file(self.config.ipa_path)
            self._set_phase("complete", "Gelato iOS App 已完成签名，可通过网络安装")
        except asyncio.CancelledError:
            self._set_phase("cancelled", "配置流程已停止")
            raise
        except Exception as error:
            self.error = self._safe_error(error)
            self._set_phase("failed", "配置未完成")
        finally:
            credentials = ""
            username = ""
            password = ""
            self._process = None
            self._response_kind = None

    async def _run_xtool_login(self, credentials: str) -> None:
        command = self.command_preview()[0]
        process = await self._spawn(command)
        self._process = process
        assert process.stdin is not None
        process.stdin.write(credentials.encode("utf-8") + b"\n")
        await process.stdin.drain()
        stdout_task = asyncio.create_task(self._consume_xtool_stdout(process.stdout))
        stderr_task = asyncio.create_task(self._consume_stderr(process.stderr))
        return_code = await process.wait()
        await asyncio.gather(stdout_task, stderr_task)
        if return_code != 0:
            raise RuntimeError("Apple 开发者签名登录失败")

    async def _consume_xtool_stdout(self, reader: asyncio.StreamReader | None) -> None:
        if reader is None:
            return
        tail = b""
        marker = b"Code: "
        while chunk := await reader.read(256):
            tail = (tail + chunk)[-2048:]
            if marker in tail and self._response_kind is None:
                self._response_kind = "2fa"
                self._set_phase("signing_login_2fa", "请输入 Apple 验证码")

    async def _run_ipsw_download(self, credentials: str) -> None:
        command = self.command_preview()[1]
        process = await self._spawn(command)
        self._process = process
        assert process.stdin is not None
        process.stdin.write(credentials.encode("utf-8") + b"\n")
        await process.stdin.drain()
        stdout_task = asyncio.create_task(self._consume_ipsw_stdout(process.stdout))
        stderr_task = asyncio.create_task(self._consume_stderr(process.stderr))
        return_code = await process.wait()
        await asyncio.gather(stdout_task, stderr_task)
        if return_code != 0:
            raise RuntimeError("Apple Xcode 下载失败")

    async def _consume_ipsw_stdout(self, reader: asyncio.StreamReader | None) -> None:
        if reader is None:
            return
        while line := await reader.readline():
            try:
                event = json.loads(line)
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            if not isinstance(event, dict):
                continue
            if event.get("event") == "needs_2fa":
                self._response_kind = "2fa"
                self._set_phase("downloading_xcode_2fa", "请输入 Apple 验证码")
            elif event.get("event") == "needs_phone":
                phones = event.get("phones")
                if not isinstance(phones, list):
                    raise RuntimeError("Apple 返回了无效的受信任号码列表")
                self.selected_download = {"phones": phones}
                self._response_kind = "phone"
                self._set_phase("downloading_xcode_phone", "请选择验证码接收号码")
            elif event.get("event") == "selected_download":
                self.selected_download = {
                    "product": str(event.get("product", ""))[:160],
                    "file": str(event.get("file", ""))[:160],
                    "size": int(event.get("size", 0)),
                    "destination": str(event.get("destination", ""))[:255],
                }
                self._set_phase("downloading_xcode", "正在下载选定的 Xcode 27")

    async def _run_command(
        self, command: list[str], *, env: dict[str, str] | None = None
    ) -> None:
        process = await self._spawn(command, env=env)
        self._process = process
        stdout_task = asyncio.create_task(self._discard_output(process.stdout))
        stderr_task = asyncio.create_task(self._consume_stderr(process.stderr))
        return_code = await process.wait()
        await asyncio.gather(stdout_task, stderr_task)
        if return_code != 0:
            raise RuntimeError("Linux 构建阶段执行失败")

    async def _spawn(
        self, command: list[str], *, env: dict[str, str] | None = None
    ) -> asyncio.subprocess.Process:
        process_env = os.environ.copy()
        swift_bin_dir = str(self.config.swift.resolve().parent)
        inherited_path = process_env.get("PATH", "")
        process_env.update(
            {
                "HOME": str(self.config.private_home),
                "XDG_CONFIG_HOME": str(self.config.private_home / ".config"),
                "XDG_CACHE_HOME": str(self.config.private_home / ".cache"),
                "PATH": os.pathsep.join(
                    part for part in (swift_bin_dir, inherited_path) if part
                ),
            }
        )
        if env:
            process_env.update(env)
        return await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=process_env,
            preexec_fn=_subprocess_umask,
        )

    async def _discard_output(self, reader: asyncio.StreamReader | None) -> None:
        if reader is None:
            return
        while await reader.read(8192):
            pass

    async def _consume_stderr(self, reader: asyncio.StreamReader | None) -> None:
        if reader is None:
            return
        while chunk := await reader.read(512):
            value = chunk.decode("utf-8", errors="replace")
            self._stderr_tail = _redact((self._stderr_tail + value)[-2048:])

    async def _write_process_input(self, value: str) -> None:
        if self._process is None or self._process.stdin is None:
            raise ValueError("Apple 登录进程已经结束")
        self._process.stdin.write(value.encode("utf-8") + b"\n")
        await self._process.stdin.drain()

    def _single_xcode_archive(self) -> Path:
        destination = (
            self.selected_download.get("destination", "")
            if self.selected_download
            else ""
        )
        if not destination or Path(destination).name != destination:
            raise RuntimeError("Xcode 27 下载目标无效")
        archive = self.config.xcode_dir / destination
        expected_size = int(self.selected_download.get("size", 0))
        if (
            archive.suffix.lower() != ".xip"
            or not archive.is_file()
            or expected_size <= 0
            or archive.stat().st_size != expected_size
        ):
            raise RuntimeError("Xcode 27 归档未完整下载")
        return archive

    def _single_sdk_bundle(self) -> Path:
        bundles = sorted(self.config.sdk_dir.rglob("*.xtoolsdk"))
        if len(bundles) != 1:
            raise RuntimeError("未生成唯一的 Darwin Swift SDK")
        return bundles[0]

    def _verified_device_record(self) -> dict[str, str]:
        try:
            raw = json.loads(self.config.enrollment_record.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError) as error:
            raise RuntimeError("网络设备登记尚未完成") from error
        if not isinstance(raw, dict):
            raise RuntimeError("网络设备登记记录无效")
        if (
            raw.get("source") != "ios-profile-service-over-https"
            or raw.get("cmsSignatureVerified") is not True
            or raw.get("challengeVerified") is not True
            or not UDID_PATTERN.fullmatch(str(raw.get("udid", "")))
        ):
            raise RuntimeError("网络设备登记记录未通过验证")
        return {key: str(value) for key, value in raw.items() if value is not None}

    def _verify_xtool_token_permissions(self) -> None:
        token = self.config.private_home / ".config" / "xtool" / "data" / "XTLAuthToken"
        if not token.is_file():
            raise RuntimeError("开发者签名令牌未保存")
        mode = stat.S_IMODE(token.stat().st_mode)
        if mode & 0o077:
            token.chmod(0o600)
        if stat.S_IMODE(token.stat().st_mode) != 0o600:
            raise RuntimeError("开发者签名令牌权限不安全")

    def _safe_error(self, error: Exception) -> str:
        message = _redact(str(error)).strip()
        if not message:
            message = "未知错误"
        if self._stderr_tail:
            last_line = next(
                (
                    line.strip()
                    for line in reversed(self._stderr_tail.splitlines())
                    if line.strip()
                ),
                "",
            )
            if last_line and len(last_line) < 240:
                message = f"{message}：{last_line}"
        return message[:480]

    def _set_phase(self, phase: str, detail: str) -> None:
        self.phase = phase
        self.detail = detail
        self.updated_at = time.time()
        self._persist()

    def _restore_completed_state(self) -> None:
        status_path = self.config.state_dir / "status.json"
        try:
            saved = json.loads(status_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return
        expected_hash = saved.get("ipaSha256") if isinstance(saved, dict) else None
        if (
            isinstance(expected_hash, str)
            and re.fullmatch(r"[a-f0-9]{64}", expected_hash)
            and self.config.ipa_path.is_file()
            and secrets.compare_digest(
                _sha256_file(self.config.ipa_path), expected_hash
            )
        ):
            self.phase = "complete"
            self.detail = "Gelato iOS App 已完成签名，可通过网络安装"
            self.ipa_sha256 = expected_hash

    def _persist(self) -> None:
        _atomic_private_json(
            self.config.state_dir / "status.json",
            {
                "phase": self.phase,
                "detail": self.detail,
                "error": self.error,
                "selectedDownload": self.selected_download,
                "ipaSha256": self.ipa_sha256,
                "updatedAt": self.updated_at,
            },
        )


class BootstrapPortal:
    def __init__(self, manager: BootstrapManager) -> None:
        self.manager = manager
        self.route_token = secrets.token_urlsafe(24)
        self.session_token = secrets.token_urlsafe(32)
        self.csrf_token = secrets.token_urlsafe(32)

    def app(self) -> web.Application:
        application = web.Application(client_max_size=16 * 1024)
        prefix = f"/setup/{self.route_token}"
        application.add_routes(
            [
                web.get(f"{prefix}/", self.index),
                web.get(f"{prefix}/api/status", self.status),
                web.post(f"{prefix}/api/start", self.start),
                web.post(f"{prefix}/api/second-factor", self.second_factor),
                web.post(f"{prefix}/api/phone", self.phone),
            ]
        )
        application.on_shutdown.append(self._shutdown)
        return application

    async def index(self, _request: web.Request) -> web.Response:
        page = _bootstrap_page(self.csrf_token, self.route_token)
        response = web.Response(text=page, content_type="text/html")
        response.set_cookie(
            "serverized_setup_session",
            self.session_token,
            httponly=True,
            samesite="Strict",
            max_age=3600,
            path=f"/setup/{self.route_token}/",
        )
        self._secure_headers(response)
        return response

    async def status(self, request: web.Request) -> web.Response:
        self._authorize(request, require_csrf=False)
        response = web.json_response(self.manager.status())
        self._secure_headers(response)
        return response

    async def start(self, request: web.Request) -> web.Response:
        self._authorize(request)
        payload = await self._json(request)
        try:
            await self.manager.start(
                str(payload.get("username", "")), str(payload.get("password", ""))
            )
        except ValueError as error:
            raise web.HTTPConflict(text=str(error)) from error
        response = web.json_response(self.manager.status())
        self._secure_headers(response)
        return response

    async def second_factor(self, request: web.Request) -> web.Response:
        self._authorize(request)
        payload = await self._json(request)
        try:
            await self.manager.submit_second_factor(str(payload.get("code", "")))
        except ValueError as error:
            raise web.HTTPConflict(text=str(error)) from error
        response = web.json_response(self.manager.status())
        self._secure_headers(response)
        return response

    async def phone(self, request: web.Request) -> web.Response:
        self._authorize(request)
        payload = await self._json(request)
        index = payload.get("index")
        try:
            await self.manager.submit_phone(index)
        except ValueError as error:
            raise web.HTTPConflict(text=str(error)) from error
        response = web.json_response(self.manager.status())
        self._secure_headers(response)
        return response

    async def _json(self, request: web.Request) -> dict[str, Any]:
        try:
            payload = await request.json()
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise web.HTTPBadRequest(text="请求格式无效") from error
        if not isinstance(payload, dict):
            raise web.HTTPBadRequest(text="请求格式无效")
        return payload

    def _authorize(self, request: web.Request, *, require_csrf: bool = True) -> None:
        session = request.cookies.get("serverized_setup_session", "")
        if not secrets.compare_digest(session, self.session_token):
            raise web.HTTPUnauthorized(text="配置会话无效")
        if require_csrf:
            csrf = request.headers.get("X-Setup-CSRF", "")
            if not secrets.compare_digest(csrf, self.csrf_token):
                raise web.HTTPForbidden(text="配置请求验证失败")

    def _secure_headers(self, response: web.StreamResponse) -> None:
        response.headers["Cache-Control"] = "no-store"
        response.headers["Pragma"] = "no-cache"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = (
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
            "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
        )

    async def _shutdown(self, _application: web.Application) -> None:
        await self.manager.close()


def _bootstrap_page(csrf_token: str, route_token: str) -> str:
    csrf = html.escape(csrf_token, quote=True)
    base = f"/setup/{html.escape(route_token, quote=True)}"
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>iOS 配置</title>
<style>
*{{box-sizing:border-box}}body{{margin:0;background:#f4f5f7;color:#15171a;font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0}}
main{{width:min(520px,calc(100% - 40px));margin:0 auto;padding:64px 0}}header{{margin-bottom:36px}}h1{{font-size:28px;line-height:1.2;letter-spacing:0;margin:0 0 10px;overflow-wrap:anywhere}}p{{margin:0;color:#61666d;line-height:1.5}}
section{{border-top:1px solid #d7d9dd;padding-top:24px}}label{{display:block;font-size:14px;font-weight:600;margin:0 0 8px}}input,select{{width:100%;height:46px;border:1px solid #b8bcc2;border-radius:6px;background:#fff;color:#15171a;padding:0 12px;font:inherit;font-size:16px;letter-spacing:0;margin-bottom:18px}}
button{{width:100%;height:46px;border:0;border-radius:6px;background:#1769aa;color:#fff;font:inherit;font-size:16px;font-weight:600;letter-spacing:0;cursor:pointer}}button:disabled{{background:#92979d;cursor:default}}
#status{{display:none}}.bar{{height:4px;background:#d7d9dd;margin:22px 0;overflow:hidden}}.bar>i{{display:block;width:34%;height:100%;background:#1769aa;animation:move 1.2s linear infinite}}@keyframes move{{from{{transform:translateX(-100%)}}to{{transform:translateX(300%)}}}}
.error{{color:#b42318;margin-top:18px;white-space:pre-wrap}}.download{{font-size:14px;color:#61666d;margin-top:8px;overflow-wrap:anywhere}}
@media(prefers-color-scheme:dark){{body{{background:#111315;color:#f4f5f7}}p,.download{{color:#aeb3ba}}section{{border-color:#34383d}}input,select{{background:#191c1f;border-color:#4a4f55;color:#f4f5f7}}.bar{{background:#34383d}}}}
@media(max-width:420px){{main{{padding:42px 0}}h1{{font-size:26px}}header{{margin-bottom:28px}}}}
</style></head><body><main><header><h1>iOS 27 Linux 配置</h1><p id="subtitle">连接 Apple 开发者账户</p></header>
<section id="login"><form id="loginForm"><label for="username">Apple 账户</label><input id="username" name="username" type="email" autocomplete="username" required maxlength="320">
<label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024"><button type="submit">继续</button></form></section>
<section id="status"><p id="detail"></p><div class="bar" id="bar"><i></i></div><div class="download" id="download"></div><div class="error" id="error"></div>
<form id="codeForm" hidden><label for="code">验证码</label><input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{{6}}" required><button type="submit">验证</button></form>
<form id="phoneForm" hidden><label for="phone">接收号码</label><select id="phone"></select><button type="submit">发送验证码</button></form></section>
</main><script>
const csrf='{csrf}',base='{base}';let current={{}};
async function call(path,body){{const r=await fetch(base+path,{{method:body?'POST':'GET',headers:body?{{'content-type':'application/json','X-Setup-CSRF':csrf}}:{{}},body:body?JSON.stringify(body):undefined,cache:'no-store'}});if(!r.ok)throw new Error(await r.text());return r.json()}}
function render(s){{current=s;const retry=s.phase==='failed'||s.phase==='cancelled',active=s.phase!=='idle';document.querySelector('#login').hidden=active&&!retry;document.querySelector('#status').style.display=active?'block':'none';document.querySelector('#detail').textContent=s.detail||'';document.querySelector('#error').textContent=s.error||'';document.querySelector('#bar').hidden=!s.busy||s.needsSecondFactor||s.needsPhone;document.querySelector('#codeForm').hidden=!s.needsSecondFactor;document.querySelector('#phoneForm').hidden=!s.needsPhone;document.querySelector('#subtitle').textContent=s.complete?'配置完成':active&&!retry?'纯 Linux 构建流程':'连接 Apple 开发者账户';const d=s.selectedDownload;document.querySelector('#download').textContent=d&&d.product?(d.product+(d.file?' · '+d.file:'')):'';if(s.needsPhone){{const sel=document.querySelector('#phone');sel.replaceChildren(...s.phones.map((p,i)=>{{const o=document.createElement('option');o.value=String(i);o.textContent=p.label||('号码 '+(i+1));return o}}))}}}}
document.querySelector('#loginForm').addEventListener('submit',async e=>{{e.preventDefault();const u=document.querySelector('#username'),p=document.querySelector('#password');try{{render(await call('/api/start',{{username:u.value,password:p.value}}));p.value=''}}catch(x){{alert(x.message)}}}});
document.querySelector('#codeForm').addEventListener('submit',async e=>{{e.preventDefault();const c=document.querySelector('#code');try{{render(await call('/api/second-factor',{{code:c.value}}));c.value=''}}catch(x){{alert(x.message)}}}});
document.querySelector('#phoneForm').addEventListener('submit',async e=>{{e.preventDefault();try{{render(await call('/api/phone',{{index:Number(document.querySelector('#phone').value)}}))}}catch(x){{alert(x.message)}}}});
async function poll(){{try{{render(await call('/api/status'))}}catch(_){{}}setTimeout(poll,1000)}}poll();
</script></body></html>"""


async def serve_bootstrap_portal(
    portal: BootstrapPortal, bind: str, port: int
) -> tuple[web.AppRunner, int]:
    if bind not in {"127.0.0.1", "::1", "localhost"}:
        raise ValueError("setup portal must bind to loopback")
    runner = web.AppRunner(portal.app(), access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, bind, port)
    await site.start()
    sockets = getattr(site._server, "sockets", None)
    if not sockets:
        await runner.cleanup()
        raise RuntimeError("setup portal did not open a listening socket")
    return runner, int(sockets[0].getsockname()[1])
