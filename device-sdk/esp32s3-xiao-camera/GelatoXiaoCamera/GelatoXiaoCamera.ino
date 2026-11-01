#include <Arduino.h>
#include <ArduinoJson.h>
#include <ArduinoWebsockets.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <esp_camera.h>
#include <esp_mac.h>
#include <esp_system.h>
#include <mbedtls/sha256.h>
#include <memory>
#include <time.h>

// An 8-63 character WPA2 key is supplied at firmware-install time. It is not a Gelato
// pairing credential and must not be committed with the source.
#ifndef GELATO_SETUP_PASSWORD
#error "Set GELATO_SETUP_PASSWORD to a unique 12+ character value when compiling"
#endif

// The controller's issuing CA is supplied at build time. Never disable TLS
// verification: the one-use code and the long-lived device credential use WSS.
#include <gelato_trust_anchor.h>

using namespace websockets;

namespace {
constexpr char kAgentKind[] = "esp32s3-xiao-camera";
constexpr char kDeviceKind[] = "camera.esp32s3-xiao";
constexpr char kVersion[] = "1.1.0";
constexpr int kButtonPin = 0;  // XIAO BOOT, usable as GPIO after startup.
constexpr int kLedPin = 21;    // XIAO user LED, active low; SD is not used.
constexpr uint32_t kLeaseMs = 10000;
constexpr uint32_t kStaleMs = 30000;
constexpr uint32_t kLocalAccessWindowMs = 10 * 60 * 1000;
constexpr size_t kMaxPhotoBytes = 1024 * 1024;
constexpr size_t kLiveRotateBytes = 30 * 1024 * 1024;
constexpr uint32_t kLiveFrameIntervalMs = 1000;

Preferences prefs;
WebServer portal(80);
WebServer management(80);
WebsocketsClient control;
std::unique_ptr<WebsocketsClient> cameraStream;
enum class CameraStreamState { OFF, WAIT_READY, READY, ENDING };
CameraStreamState cameraStreamState = CameraStreamState::OFF;
bool cameraStreamAllowed = false;
bool cameraStreamDisconnected = false;
bool cameraStreamCompleted = false;
bool cameraStreamHashActive = false;
String cameraStreamId;
String cameraStreamDigest;
mbedtls_sha256_context cameraStreamHash;
uint32_t cameraStreamSequence = 0;
uint32_t cameraStreamDeadline = 0;
uint32_t nextCameraStreamConnectAt = 0;
uint32_t nextCameraFrameAt = 0;
size_t cameraStreamBytes = 0;
String setupSsid;
String installationId;
String wifiSsid;
String wifiPassword;
String controllerOrigin;
String pairingCode;
String agentId;
String deviceId;
String credential;
String lastReply;
String lastError;
String setupNonce;
String managementNonce;
bool cameraReady = false;
bool setupActive = false;
bool setupRequested = false;
bool managementActive = false;
bool managementRequested = false;
bool portalRoutesRegistered = false;
bool authenticated = false;
bool controllerTlsProbeDone = false;
bool controlAllowed = false;
bool connectionEnabled = true;
bool restartRequested = false;
uint32_t restartAt = 0;
uint32_t nextConnectAt = 0;
uint32_t nextWifiAt = 0;
uint32_t lastMessageAt = 0;
uint32_t lastLeaseAt = 0;
uint32_t snapshotRevision = 0;
uint32_t buttonDownAt = 0;
uint32_t managementUntil = 0;
bool previousButtonDown = false;
String pendingCommandId;
String pendingCapability;
String terminalIds[8];
String terminalBodies[8];
bool terminalSucceeded[8] = {};
size_t nextTerminal = 0;

String randomId(const char *prefix) {
  char hex[33];
  uint8_t bytes[16];
  esp_fill_random(bytes, sizeof(bytes));
  for (size_t i = 0; i < sizeof(bytes); ++i) sprintf(hex + i * 2, "%02x", bytes[i]);
  hex[32] = '\0';
  return String(prefix) + hex;
}

String isoNow() {
  time_t now = time(nullptr);
  struct tm utc;
  gmtime_r(&now, &utc);
  char value[25];
  strftime(value, sizeof(value), "%Y-%m-%dT%H:%M:%SZ", &utc);
  return value;
}

String websocketUrl(const String &path) {
  String origin = controllerOrigin;
  origin.replace("https://", "wss://");
  return origin + path;
}

void sendEnvelope(const char *type, JsonDocument &body, const String &commandId = "") {
  if (!control.available()) return;
  JsonDocument envelope;
  envelope["protocol"] = "gelato.v1";
  envelope["type"] = type;
  envelope["messageId"] = randomId("msg_");
  envelope["sentAt"] = isoNow();
  if (deviceId.length()) envelope["deviceId"] = deviceId;
  if (commandId.length()) envelope["commandId"] = commandId;
  envelope["body"] = body.as<JsonVariant>();
  String encoded;
  serializeJson(envelope, encoded);
  bool sent = control.send(encoded);
  if (strcmp(type, "device.snapshot") == 0 || strcmp(type, "command.result") == 0 ||
      strcmp(type, "command.error") == 0) {
    Serial.printf("Gelato %s: %s\n", type, sent ? "sent" : "send failed");
  }
}

void sendSnapshot() {
  if (!authenticated) return;
  JsonDocument body;
  body["revision"] = ++snapshotRevision;
  body["kind"] = kDeviceKind;
  body["displayName"] = setupSsid;
  body["os"]["family"] = "esp32s3";
  body["os"]["version"] = ESP.getSdkVersion();
  body["driver"]["id"] = "xiao-sense-camera";
  body["driver"]["version"] = kVersion;
  body["driver"]["location"] = "device";
  body["driver"]["state"] = cameraReady ? "ready" : "degraded";
  if (!cameraReady) body["driver"]["error"] = lastError;
  body["hardware"]["present"] = true;
  body["hardware"]["connected"] = cameraReady;
  body["hardware"]["controlAllowed"] = controlAllowed;
  body["hardware"]["cameraStreamAllowed"] = cameraStreamAllowed;
  body["hardware"]["cameraStreamActive"] = cameraStreamState == CameraStreamState::READY;
  body["hardware"]["stableKey"] = String("esp32s3:") + WiFi.macAddress();
  body["hardware"]["userAction"] = nullptr;
  JsonArray caps = body["capabilities"].to<JsonArray>();
  JsonObject describe = caps.add<JsonObject>();
  describe["name"] = "device.describe";
  describe["version"] = 1;
  if (cameraReady) {
    JsonObject capture = caps.add<JsonObject>();
    capture["name"] = "camera.capture";
    capture["version"] = 1;
    capture["consent"] = "local-portal-or-button";
    capture["limits"]["mimeType"] = "image/jpeg";
    capture["limits"]["maxBytes"] = kMaxPhotoBytes;
  }
  sendEnvelope("device.snapshot", body);
}

void sendTerminal(const String &commandId, bool ok, const String &error,
                  const String &streamId = "", size_t size = 0,
                  const String &sha = "") {
  JsonDocument body;
  if (ok) {
    JsonObject result = body["result"].to<JsonObject>();
    if (streamId.length()) {
      result["stream"]["streamId"] = streamId;
      result["stream"]["purpose"] = "photo";
      result["stream"]["contentType"] = "image/jpeg";
      result["stream"]["sizeBytes"] = size;
      result["stream"]["sha256"] = sha;
    } else {
      result["kind"] = kDeviceKind;
      result["cameraReady"] = cameraReady;
      result["controlAllowed"] = controlAllowed;
      result["sensorPid"] = cameraReady ? esp_camera_sensor_get()->id.PID : 0;
    }
  } else {
    body["error"] = error;
  }
  terminalBodies[nextTerminal] = "";
  serializeJson(body, terminalBodies[nextTerminal]);
  terminalIds[nextTerminal] = commandId;
  terminalSucceeded[nextTerminal] = ok;
  nextTerminal = (nextTerminal + 1) % 8;
  sendEnvelope(ok ? "command.result" : "command.error", body, commandId);
}

String sha256Hex(const uint8_t *data, size_t length) {
  uint8_t digest[32];
  mbedtls_sha256_context hash;
  mbedtls_sha256_init(&hash);
  mbedtls_sha256_starts(&hash, 0);
  mbedtls_sha256_update(&hash, data, length);
  mbedtls_sha256_finish(&hash, digest);
  mbedtls_sha256_free(&hash);
  char hex[65];
  for (size_t i = 0; i < sizeof(digest); ++i) sprintf(hex + i * 2, "%02x", digest[i]);
  hex[64] = '\0';
  return String(hex);
}

// Direct typed stream keeps JPEG bytes out of the JSON control channel. The
// server checks device authentication, frame sequence, byte count and SHA-256.
bool uploadPhoto(camera_fb_t *frame, const String &commandId, String &streamId,
                 String &digest) {
  if (!frame || frame->len == 0 || frame->len > kMaxPhotoBytes || !controlAllowed) return false;
  streamId = randomId("str_");
  digest = sha256Hex(frame->buf, frame->len);
  WebsocketsClient stream;
  stream.setCACert(GELATO_TRUST_ANCHOR_PEM);
  stream.addHeader("Authorization", String("Bearer ") + credential);
  stream.addHeader("X-Agent-Id", agentId);
  stream.addHeader("X-Device-Id", deviceId);
  bool ready = false;
  bool complete = false;
  bool failed = false;
  stream.onMessage([&](WebsocketsMessage message) {
    JsonDocument response;
    if (deserializeJson(response, message.data())) return;
    String type = response["type"].as<String>();
    if (type == "stream.ready" && response["streamId"].as<String>() == streamId) ready = true;
    if (type == "stream.complete" && response["streamId"].as<String>() == streamId &&
        response["sha256"].as<String>().equalsIgnoreCase(digest)) complete = true;
    if (type == "stream.failed" || type == "protocol.error") failed = true;
  });
  if (!stream.connect(websocketUrl("/agent/streams/live"))) return false;
  JsonDocument offer;
  offer["protocol"] = "gelato.v1";
  offer["type"] = "stream.offer";
  offer["messageId"] = randomId("msg_");
  offer["sentAt"] = isoNow();
  offer["deviceId"] = deviceId;
  offer["body"]["streamId"] = streamId;
  if (commandId.length()) offer["body"]["commandId"] = commandId;
  offer["body"]["purpose"] = "photo";
  offer["body"]["direction"] = "agent-to-controller";
  offer["body"]["contentType"] = "image/jpeg";
  offer["body"]["maxFrameBytes"] = kMaxPhotoBytes;
  offer["body"]["maxTotalBytes"] = kMaxPhotoBytes;
  offer["body"]["expectedBytes"] = frame->len;
  offer["body"]["metadata"]["observationFraming"] = "image-per-message.v1";
  String encoded;
  serializeJson(offer, encoded);
  if (!stream.send(encoded)) return false;
  uint32_t deadline = millis() + 10000;
  while (!ready && !failed && stream.available() && static_cast<int32_t>(deadline - millis()) > 0) {
    stream.poll();
    delay(5);
  }
  if (!ready || !controlAllowed) return false;
  uint8_t *packet = static_cast<uint8_t *>(ps_malloc(frame->len + 4));
  if (!packet) return false;
  memset(packet, 0, 4);  // Sequence 0, big endian.
  memcpy(packet + 4, frame->buf, frame->len);
  bool sent = stream.sendBinary(reinterpret_cast<const char *>(packet), frame->len + 4);
  free(packet);
  if (!sent) return false;
  JsonDocument end;
  end["type"] = "stream.end";
  end["totalBytes"] = frame->len;
  end["sha256"] = digest;
  encoded = "";
  serializeJson(end, encoded);
  if (!stream.send(encoded)) return false;
  deadline = millis() + 15000;
  while (!complete && !failed && stream.available() && static_cast<int32_t>(deadline - millis()) > 0) {
    stream.poll();
    delay(5);
  }
  stream.close();
  return complete;
}

// A locally authorized, outbound JPEG stream. The separate socket leaves the
// control channel free for leases and commands; no remote capture command is
// issued for each frame. There is only one in-flight frame on this MCU.
void closeCameraStream() {
  bool wasOpen = cameraStreamState != CameraStreamState::OFF;
  if (cameraStream) {
    if (cameraStream->available()) cameraStream->close();
    cameraStream.reset();
  }
  cameraStreamState = CameraStreamState::OFF;
  cameraStreamDisconnected = false;
  cameraStreamCompleted = false;
  cameraStreamId = "";
  if (cameraStreamHashActive) {
    mbedtls_sha256_free(&cameraStreamHash);
    cameraStreamHashActive = false;
  }
  if (wasOpen) sendSnapshot();
}

void beginCameraStream() {
  cameraStreamId = randomId("str_");
  cameraStreamSequence = 0;
  cameraStreamBytes = 0;
  cameraStreamDigest = "";
  cameraStreamDisconnected = false;
  cameraStreamCompleted = false;
  // ArduinoWebsockets appends headers on every addHeader call. A fresh client
  // per rotation prevents duplicate credentials and unbounded header growth.
  cameraStream.reset(new WebsocketsClient());
  cameraStream->setCACert(GELATO_TRUST_ANCHOR_PEM);
  cameraStream->addHeader("Authorization", String("Bearer ") + credential);
  cameraStream->addHeader("X-Agent-Id", agentId);
  cameraStream->addHeader("X-Device-Id", deviceId);
  cameraStream->onMessage([](WebsocketsMessage message) {
    if (!message.isText()) return;
    JsonDocument reply;
    if (deserializeJson(reply, message.data())) return;
    String type = reply["type"].as<String>();
    if (type == "protocol.error") {
      cameraStreamDisconnected = true;
      return;
    }
    if (reply["streamId"].as<String>() != cameraStreamId) return;
    if (type == "stream.ready" && cameraStreamState == CameraStreamState::WAIT_READY) {
      cameraStreamState = CameraStreamState::READY;
      nextCameraFrameAt = 0;
      sendSnapshot();
    } else if (type == "stream.complete" && cameraStreamState == CameraStreamState::ENDING) {
      cameraStreamCompleted = reply["sha256"].as<String>().equalsIgnoreCase(cameraStreamDigest);
    } else if (type == "stream.failed") {
      cameraStreamDisconnected = true;
    }
  });
  cameraStream->onEvent([](WebsocketsEvent event, String) {
    if (event == WebsocketsEvent::ConnectionClosed) cameraStreamDisconnected = true;
  });
  if (!cameraStream->connect(websocketUrl("/agent/streams/live"))) {
    nextCameraStreamConnectAt = millis() + 5000;
    closeCameraStream();
    return;
  }
  mbedtls_sha256_init(&cameraStreamHash);
  mbedtls_sha256_starts(&cameraStreamHash, 0);
  cameraStreamHashActive = true;
  JsonDocument offer;
  offer["protocol"] = "gelato.v1";
  offer["type"] = "stream.offer";
  offer["messageId"] = randomId("msg_");
  offer["sentAt"] = isoNow();
  offer["deviceId"] = deviceId;
  offer["body"]["streamId"] = cameraStreamId;
  offer["body"]["purpose"] = "photo";
  offer["body"]["direction"] = "agent-to-controller";
  offer["body"]["contentType"] = "image/jpeg";
  offer["body"]["maxFrameBytes"] = kMaxPhotoBytes;
  offer["body"]["maxTotalBytes"] = 32 * 1024 * 1024;
  offer["body"]["metadata"]["observationFraming"] = "image-per-message.v1";
  offer["body"]["metadata"]["transient"] = true;
  String encoded;
  serializeJson(offer, encoded);
  cameraStreamState = CameraStreamState::WAIT_READY;
  cameraStreamDeadline = millis() + 10000;
  if (!cameraStream->send(encoded)) {
    nextCameraStreamConnectAt = millis() + 5000;
    closeCameraStream();
  }
}

void finishCameraStream() {
  if (cameraStreamState != CameraStreamState::READY || !cameraStreamHashActive) return;
  uint8_t digest[32];
  mbedtls_sha256_finish(&cameraStreamHash, digest);
  mbedtls_sha256_free(&cameraStreamHash);
  cameraStreamHashActive = false;
  char hex[65];
  for (size_t i = 0; i < sizeof(digest); ++i) sprintf(hex + i * 2, "%02x", digest[i]);
  hex[64] = '\0';
  cameraStreamDigest = String(hex);
  JsonDocument end;
  end["type"] = "stream.end";
  end["totalBytes"] = cameraStreamBytes;
  end["sha256"] = cameraStreamDigest;
  String encoded;
  serializeJson(end, encoded);
  cameraStreamState = CameraStreamState::ENDING;
  cameraStreamDeadline = millis() + 10000;
  if (!cameraStream || !cameraStream->send(encoded)) cameraStreamDisconnected = true;
}

void pumpCameraStream() {
  bool permitted = !setupActive && connectionEnabled && authenticated && controlAllowed &&
    cameraStreamAllowed && cameraReady && WiFi.status() == WL_CONNECTED;
  if (!permitted) {
    closeCameraStream();
    return;
  }
  if (cameraStreamState == CameraStreamState::OFF) {
    if (static_cast<int32_t>(millis() - nextCameraStreamConnectAt) >= 0) beginCameraStream();
    return;
  }
  if (cameraStream && cameraStream->available()) cameraStream->poll();
  if (cameraStreamDisconnected || !cameraStream || !cameraStream->available() || cameraStreamCompleted ||
      (cameraStreamState != CameraStreamState::READY &&
       static_cast<int32_t>(millis() - cameraStreamDeadline) >= 0)) {
    nextCameraStreamConnectAt = millis() + (cameraStreamCompleted ? 250 : 5000);
    closeCameraStream();
    return;
  }
  if (cameraStreamState != CameraStreamState::READY ||
      static_cast<int32_t>(millis() - nextCameraFrameAt) < 0) return;
  nextCameraFrameAt = millis() + kLiveFrameIntervalMs;
  camera_fb_t *frame = esp_camera_fb_get();
  if (!frame) return;
  if (frame->len == 0 || frame->len > kMaxPhotoBytes) {
    esp_camera_fb_return(frame);
    return;
  }
  if (cameraStreamBytes + frame->len > kLiveRotateBytes) {
    esp_camera_fb_return(frame);
    finishCameraStream();
    return;
  }
  uint8_t *packet = static_cast<uint8_t *>(ps_malloc(frame->len + 4));
  if (!packet) {
    esp_camera_fb_return(frame);
    return;
  }
  packet[0] = (cameraStreamSequence >> 24) & 0xff;
  packet[1] = (cameraStreamSequence >> 16) & 0xff;
  packet[2] = (cameraStreamSequence >> 8) & 0xff;
  packet[3] = cameraStreamSequence & 0xff;
  memcpy(packet + 4, frame->buf, frame->len);
  bool sent = cameraStream->sendBinary(reinterpret_cast<const char *>(packet), frame->len + 4);
  if (sent) {
    mbedtls_sha256_update(&cameraStreamHash, frame->buf, frame->len);
    cameraStreamBytes += frame->len;
    ++cameraStreamSequence;
  }
  free(packet);
  esp_camera_fb_return(frame);
  if (!sent) {
    nextCameraStreamConnectAt = millis() + 5000;
    closeCameraStream();
  }
}

void captureAndRespond(const String &commandId) {
  if (!cameraReady || !controlAllowed) {
    if (commandId.length()) sendTerminal(commandId, false, "Camera unavailable or local control paused");
    return;
  }
  // The legacy one-shot upload waits for its own acknowledgement. Close the
  // preview first so its socket never starves while that upload is in flight.
  if (cameraStreamState != CameraStreamState::OFF) {
    closeCameraStream();
    nextCameraStreamConnectAt = millis() + 1000;
  }
  JsonDocument lease;
  lease["revision"] = snapshotRevision;
  sendEnvelope("lease.renew", lease);
  lastLeaseAt = millis();
  camera_fb_t *frame = esp_camera_fb_get();
  if (!frame) {
    if (commandId.length()) sendTerminal(commandId, false, "Camera capture failed");
    return;
  }
  String streamId, digest;
  size_t size = frame->len;
  bool uploaded = uploadPhoto(frame, commandId, streamId, digest);
  esp_camera_fb_return(frame);
  if (!uploaded) {
    if (commandId.length()) sendTerminal(commandId, false, "JPEG stream upload failed");
    return;
  }
  if (commandId.length()) {
    sendTerminal(commandId, true, "", streamId, size, digest);
  } else {
    JsonDocument input;
    input["kind"] = "observation";
    JsonObject part = input["parts"].to<JsonArray>().add<JsonObject>();
    part["type"] = "media";
    part["streamId"] = streamId;
    part["mimeType"] = "image/jpeg";
    sendEnvelope("input.publish", input);
  }
}

void onControlMessage(WebsocketsMessage message) {
  if (!message.isText()) return;
  JsonDocument envelope;
  if (deserializeJson(envelope, message.data()) || envelope["protocol"] != "gelato.v1") return;
  lastMessageAt = millis();
  String type = envelope["type"].as<String>();
  if (type != "lease.ack") Serial.printf("Gelato control received: %s\n", type.c_str());
  JsonObject body = envelope["body"].as<JsonObject>();
  if (type == "pairing.accepted" || type == "session.accepted") {
    String nextAgent = body["agentId"].as<String>();
    String nextDevice = body["deviceId"].as<String>();
    JsonVariant credentialValue = body["credential"];
    String nextCredential = credentialValue.isNull() ? credential : credentialValue.as<String>();
    bool validAgent = nextAgent.startsWith("agt_");
    bool validDevice = nextDevice.startsWith("dev_");
    bool validCredential = nextCredential.startsWith("agtcred_");
    if (!validAgent || !validDevice || !validCredential) {
      Serial.printf("Gelato authentication response invalid: agent=%d device=%d credential=%d\n",
                    validAgent, validDevice, validCredential);
      return;
    }
    agentId = nextAgent;
    deviceId = nextDevice;
    credential = nextCredential;
    prefs.putString("agent", agentId);
    prefs.putString("device", deviceId);
    prefs.putString("credential", credential);
    prefs.remove("pairCode");
    pairingCode = "";
    authenticated = true;
    snapshotRevision = 0;
    sendSnapshot();
    if (type == "pairing.accepted" && !managementActive) managementRequested = true;
  } else if (type == "pairing.rejected") {
    lastError = body["error"].as<String>();
    authenticated = false;
    setupRequested = true;
  } else if (type == "session.rejected") {
    lastError = body["error"].as<String>();
    authenticated = false;
    prefs.remove("credential");
    prefs.remove("agent");
    prefs.remove("device");
    credential = agentId = deviceId = "";
    setupRequested = true;
  } else if (type == "device.snapshot.request") {
    sendSnapshot();
  } else if (type == "command.request") {
    if (!authenticated || envelope["deviceId"].as<String>() != deviceId) return;
    String id = envelope["commandId"].as<String>();
    String capability = body["capability"].as<String>();
    int version = body["capabilityVersion"] | 0;
    if (!id.startsWith("cmd_") || version != 1) return;
    for (size_t i = 0; i < 8; ++i) {
      if (terminalIds[i] != id) continue;
      JsonDocument previous;
      if (!deserializeJson(previous, terminalBodies[i])) {
        sendEnvelope(terminalSucceeded[i] ? "command.result" : "command.error", previous, id);
      }
      return;
    }
    if (pendingCommandId == id) return;
    if (pendingCommandId.length()) {
      sendTerminal(id, false, "Camera is busy");
      return;
    }
    pendingCommandId = id;
    pendingCapability = capability;
  } else if (type == "command.cancel") {
    String id = envelope["commandId"].as<String>();
    if (id == pendingCommandId) {
      pendingCommandId = "";
      pendingCapability = "";
      sendTerminal(id, false, "Cancelled before capture");
    }
  } else if (type == "reply.deliver") {
    if (!authenticated || envelope["deviceId"].as<String>() != deviceId) return;
    String text = body["text"].as<String>();
    if (text.length() && text.length() <= 32768) {
      lastReply = text;
      // NVS strings have a small single-entry limit. The full reply remains
      // available in RAM until restart; a short recovery preview survives it.
      prefs.putString("lastReply", text.substring(0, 2048));
      JsonDocument ack;
      ack["replyMessageId"] = envelope["messageId"].as<String>();
      sendEnvelope("reply.ack", ack);
    }
  } else if (type == "protocol.error") {
    lastError = body["error"].as<String>();
    Serial.printf("Gelato protocol error: %s\n", lastError.c_str());
  }
}

void connectControl() {
  if (WiFi.status() != WL_CONNECTED || !controllerOrigin.length() ||
      (!credential.length() && !pairingCode.length())) return;
  if (time(nullptr) < 1700000000) {
    configTime(0, 0, "ntp.aliyun.com", "time.cloudflare.com");
    uint32_t deadline = millis() + 12000;
    while (time(nullptr) < 1700000000 && static_cast<int32_t>(deadline - millis()) > 0) delay(100);
    if (time(nullptr) < 1700000000) {
      lastError = "Clock sync failed; TLS certificate cannot be checked";
      return;
    }
  }
  control.setCACert(GELATO_TRUST_ANCHOR_PEM);
  control.onMessage(onControlMessage);
  control.onEvent([](WebsocketsEvent event, String) {
    if (event == WebsocketsEvent::ConnectionClosed) authenticated = false;
  });
  if (!control.connect(websocketUrl("/agent/control"))) {
    lastError = "Controller TLS/WebSocket connection failed";
    if (!controllerTlsProbeDone) {
      controllerTlsProbeDone = true;
      String authority = controllerOrigin.substring(strlen("https://"));
      int separator = authority.lastIndexOf(':');
      String host = separator < 0 ? authority : authority.substring(0, separator);
      int port = separator < 0 ? 443 : authority.substring(separator + 1).toInt();
      if (host.length() && port > 0 && port <= 65535) {
        WiFiClientSecure probe;
        probe.setCACert(GELATO_TRUST_ANCHOR_PEM);
        probe.setTimeout(5);
        if (probe.connect(host.c_str(), port)) {
          lastError = "Controller TLS works; WebSocket upgrade failed";
          probe.stop();
        } else {
          char detail[128] = {};
          probe.lastError(detail, sizeof(detail));
          lastError = String("Controller TLS failed: ") + detail;
        }
      }
    }
    Serial.printf("Gelato connection error: %s\n", lastError.c_str());
    return;
  }
  lastError = "";
  Serial.println("Gelato Controller WebSocket connected");
  JsonDocument hello;
  hello["installationId"] = installationId;
  hello["agentKind"] = kAgentKind;
  hello["hostPlatform"] = "esp32s3";
  hello["deviceKind"] = kDeviceKind;
  hello["displayName"] = setupSsid;
  hello["agentVersion"] = kVersion;
  if (credential.length()) {
    hello["agentId"] = agentId;
    hello["credential"] = credential;
    sendEnvelope("session.hello", hello);
  } else {
    hello["pairingCode"] = pairingCode;
    sendEnvelope("pairing.request", hello);
  }
  lastMessageAt = millis();
}

String htmlEscape(String value) {
  value.replace("&", "&amp;");
  value.replace("<", "&lt;");
  value.replace(">", "&gt;");
  value.replace("\"", "&quot;");
  value.replace("'", "&#39;");
  return value;
}

void stopManagementWindow() {
  if (!managementActive) return;
  management.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  managementActive = false;
  Serial.println("Gelato local access window closed");
}

void startManagementWindow() {
  if (setupActive || managementActive || !credential.length() || WiFi.status() != WL_CONNECTED) return;
  managementNonce = randomId("local_");
  WiFi.mode(WIFI_AP_STA);
  if (!WiFi.softAP(setupSsid.c_str(), GELATO_SETUP_PASSWORD)) {
    lastError = "Local access Wi-Fi did not start";
    return;
  }
  management.on("/", HTTP_GET, [] {
    // The setup WPA2 key is the local authorization factor. Never expose this
    // consent page to clients on the normal LAN interface.
    if (management.client().localIP() != WiFi.softAPIP()) {
      management.send(403, "text/plain", "Join the device setup Wi-Fi first.");
      return;
    }
    // Give someone who has opened the form a full window to finish it, even
    // if the board was powered on several minutes earlier.
    managementUntil = millis() + kLocalAccessWindowMs;
    String page = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
      "<title>Gelato Camera Access</title><style>body{font:16px system-ui;max-width:32em;"
      "margin:2em auto;padding:0 1em}label{display:block;margin:1em 0}button{padding:.8em 1.2em}"
      "</style><h1>Gelato Camera</h1><p>Paired with Controller. Choose what it may do. "
      "These settings persist after this temporary Wi-Fi closes.</p><form method=post action=/access>"
      "<input type=hidden name=nonce value='";
    page += managementNonce;
    page += "'><label><input type=checkbox name=connection value=1";
    if (connectionEnabled) page += " checked";
    page += "> Connect to Controller</label><label><input type=checkbox name=allow value=1";
    if (controlAllowed) page += " checked";
    page += "> Allow remote camera capture</label><label><input type=checkbox name=stream value=1";
    if (cameraStreamAllowed) page += " checked";
    page += "> Continuously send camera preview (~1 JPEG frame/second while connected and allowed)"
      "</label><button type=submit>Save access settings</button>"
      "</form><p>The local setup Wi-Fi closes 10 minutes after this page is opened. "
      "Power-cycle the board to reopen it. "
      "No physical button is required.</p>";
    if (lastError.length()) page += "<p>Connection error: " + htmlEscape(lastError) + "</p>";
    management.send(200, "text/html; charset=utf-8", page);
  });
  management.on("/access", HTTP_POST, [] {
    if (management.client().localIP() != WiFi.softAPIP() ||
        management.arg("nonce") != managementNonce) {
      management.send(403, "text/plain", "Reopen the local page and retry.");
      return;
    }
    bool allow = management.hasArg("allow");
    if (allow && (!cameraReady || !credential.length())) {
      management.send(409, "text/plain", "Camera or pairing is not ready.");
      return;
    }
    bool connect = management.hasArg("connection");
    bool wasConnected = connectionEnabled;
    controlAllowed = allow;
    connectionEnabled = connect;
    cameraStreamAllowed = allow && management.hasArg("stream");
    prefs.putBool("allowed", controlAllowed);
    prefs.putBool("connection", connectionEnabled);
    prefs.putBool("streamAllowed", cameraStreamAllowed);
    // Acknowledge the saved local choice before any stream close or outbound
    // Controller traffic can delay the browser response.
    management.send(200, "text/html; charset=utf-8",
      "<h1>Saved</h1><p>Connection and camera access settings were saved. "
      "This local Wi-Fi will close shortly.</p>");
    managementUntil = millis() + 15000;
    if (!cameraStreamAllowed || !connectionEnabled) closeCameraStream();
    sendSnapshot();
    if (!connectionEnabled) {
      authenticated = false;
      control.close();
    } else if (!wasConnected) {
      nextConnectAt = 0;
    }
  });
  management.begin();
  managementActive = true;
  managementUntil = millis() + kLocalAccessWindowMs;
  Serial.printf("Gelato local access AP: %s at %s\n", setupSsid.c_str(),
                WiFi.softAPIP().toString().c_str());
}

void startSetup() {
  if (setupActive) return;
  stopManagementWindow();
  controlAllowed = false;
  cameraStreamAllowed = false;
  closeCameraStream();
  sendSnapshot();
  authenticated = false;
  control.close();
  prefs.putBool("allowed", false);
  prefs.putBool("streamAllowed", false);
  setupNonce = randomId("setup_");
  WiFi.disconnect(true);
  WiFi.mode(WIFI_AP);
  if (!WiFi.softAP(setupSsid.c_str(), GELATO_SETUP_PASSWORD)) {
    lastError = "Setup Wi-Fi did not start";
    return;
  }
  if (!portalRoutesRegistered) {
  portal.on("/preflight.json", HTTP_GET, [] {
    JsonDocument checklist;
    JsonArray steps = checklist.to<JsonArray>();
    auto addStep = [&](const char *id, const char *title, const char *detail,
                       bool done, const char *action, const char *button) {
      JsonObject step = steps.add<JsonObject>();
      step["id"] = id;
      step["title"] = title;
      step["detail"] = detail;
      step["done"] = done;
      JsonObject check = step["check"].to<JsonObject>();
      check["state"] = done ? "passed" : "failed";
      check["basis"] = "probe";
      step["phase"] = "before-pairing";
      step["required"] = true;
      step["action"] = action;
      step["button"] = button;
    };
    addStep("camera", "Camera attached", "The camera ribbon and sensor must initialize locally.",
            cameraReady, "power-cycle", "Check ribbon, then restart board");
    addStep("wifi", "2.4 GHz Wi-Fi", "Enter local Wi-Fi details below. The board joins it after submission.",
            wifiSsid.length() > 0, "configure-wifi", "Enter Wi-Fi below");
    addStep("pairing-code", "Gelato one-use code", "Create a fresh code in Controller, then submit it below.",
            credential.length() > 0 || pairingCode.length() > 0,
            "enter-pairing-code", "Enter code below");
    String encoded;
    serializeJson(checklist, encoded);
    portal.send(200, "application/json", encoded);
  });
  portal.on("/", HTTP_GET, [] {
    String page = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
      "<title>Gelato Camera Setup</title><style>body{font:16px system-ui;max-width:32em;"
      "margin:2em auto;padding:0 1em}input{display:block;width:100%;box-sizing:border-box;"
      "padding:.8em;margin:.4em 0 1em}button{padding:.8em 1.2em}</style>"
      "<h1>Gelato Camera</h1><p>1. Confirm the camera is attached. 2. Enter a 2.4 GHz "
      "Wi-Fi network. 3. Create a one-use pairing code in your Gelato Controller and enter it here. "
      "Nothing is paired until you press Configure.</p>";
    page += String("<p>Camera: ") + (cameraReady ? "ready" : "not detected — check camera ribbon") +
      "</p><p>Before pairing: camera ready, 2.4 GHz Wi-Fi details, and a fresh Controller code.</p>";
    if (lastError.length()) page += "<p>Error: " + htmlEscape(lastError) + "</p>";
    if (credential.length()) page += "<p>Already paired. Leave the code blank to update Wi-Fi/server only.</p>";
    if (lastReply.length()) page += "<h2>Last reply</h2><p>" + htmlEscape(lastReply) + "</p>";
    page += "<form method=post action=/configure><input type=hidden name=nonce value='" +
      setupNonce + "'><label>2.4 GHz Wi-Fi name"
      "<input name=ssid maxlength=32 required></label><label>Wi-Fi password"
      "<input name=password type=password maxlength=63></label><label>Gelato Controller HTTPS origin"
      "<input name=origin type=url placeholder=https://controller.example.com value='" +
      htmlEscape(controllerOrigin) + "' required></label>"
      "<label>One-use pairing code<input name=code maxlength=32";
    if (!credential.length()) page += " required";
    page += "></label><p>Camera access starts OFF. After pairing, reconnect to this temporary "
      "Gelato-Camera Wi-Fi and open this page again to explicitly allow remote capture. "
      "Power-cycle the board to reopen the local access page later; no button is required.</p>"
      "<button type=submit>Configure wirelessly</button></form>";
    portal.send(200, "text/html; charset=utf-8", page);
  });
  portal.on("/configure", HTTP_POST, [] {
    String ssid = portal.arg("ssid");
    String password = portal.arg("password");
    String origin = portal.arg("origin");
    String code = portal.arg("code");
    if (portal.arg("nonce") != setupNonce) {
      portal.send(403, "text/plain; charset=utf-8", "Reopen the setup page and retry.");
      return;
    }
    origin.trim();
    while (origin.endsWith("/")) origin.remove(origin.length() - 1);
    bool validOrigin = origin.startsWith("https://") && origin.length() < 240 &&
      origin.indexOf('/', 8) < 0 && origin.indexOf('?') < 0 && origin.indexOf('#') < 0 &&
      origin.indexOf('@') < 0;
    if (!cameraReady || !ssid.length() || ssid.length() > 32 || password.length() > 63 ||
        !validOrigin || (!credential.length() && (code.length() < 6 || code.length() > 32)) ||
        (credential.length() && origin != controllerOrigin && !code.length())) {
      portal.send(400, "text/plain; charset=utf-8", "Check camera, Wi-Fi, HTTPS origin and pairing code.");
      return;
    }
    prefs.putString("ssid", ssid);
    prefs.putString("wifiPass", password);
    prefs.putString("origin", origin);
    prefs.putBool("connection", true);
    if (code.length()) {
      prefs.putString("pairCode", code);
      if (credential.length()) {
        // Re-pairing is explicit and rotates the server-issued credential.
        prefs.remove("agent");
        prefs.remove("device");
        prefs.remove("credential");
      }
    }
    portal.send(200, "text/html; charset=utf-8", "<h1>Saved</h1><p>The camera will connect to Wi-Fi "
      "and pair over WSS. Rejoin your normal Wi-Fi to see it in Gelato.</p>");
    restartRequested = true;
    restartAt = millis() + 1200;
  });
  portalRoutesRegistered = true;
  }
  portal.begin();
  setupActive = true;
  Serial.printf("Gelato wireless setup AP: %s at %s\n", setupSsid.c_str(), WiFi.softAPIP().toString().c_str());
}

void initCamera() {
  camera_config_t config = {};
  config.pin_pwdn = -1;
  config.pin_reset = -1;
  config.pin_xclk = 10;
  config.pin_sccb_sda = 40;
  config.pin_sccb_scl = 39;
  config.pin_d7 = 48;
  config.pin_d6 = 11;
  config.pin_d5 = 12;
  config.pin_d4 = 14;
  config.pin_d3 = 16;
  config.pin_d2 = 18;
  config.pin_d1 = 17;
  config.pin_d0 = 15;
  config.pin_vsync = 38;
  config.pin_href = 47;
  config.pin_pclk = 13;
  config.xclk_freq_hz = 20000000;
  config.ledc_timer = LEDC_TIMER_0;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = FRAMESIZE_VGA;
  config.jpeg_quality = 12;
  config.fb_count = 1;
  config.fb_location = CAMERA_FB_IN_PSRAM;
  config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  esp_err_t result = esp_camera_init(&config);
  cameraReady = result == ESP_OK;
  if (!cameraReady) lastError = String("Camera init failed: ") + result;
  Serial.printf("Gelato camera: %s, sensor PID: 0x%04X\n", cameraReady ? "ready" : "failed",
                cameraReady ? esp_camera_sensor_get()->id.PID : 0);
}

void handleButton() {
  bool down = digitalRead(kButtonPin) == LOW;
  if (down && !previousButtonDown) buttonDownAt = millis();
  if (!down && previousButtonDown) {
    uint32_t duration = millis() - buttonDownAt;
    if (duration >= 8000) {
      startSetup();
    } else if (duration >= 3000 && !setupActive) {
      controlAllowed = !controlAllowed;
      prefs.putBool("allowed", controlAllowed);
      if (!controlAllowed) closeCameraStream();
      sendSnapshot();
    } else if (duration >= 1000 && !setupActive) {
      connectionEnabled = !connectionEnabled;
      prefs.putBool("connection", connectionEnabled);
      if (!connectionEnabled) {
        closeCameraStream();
        authenticated = false;
        control.close();
      } else {
        nextConnectAt = 0;
      }
    } else if (duration >= 50 && duration < 1000 && authenticated && controlAllowed) {
      captureAndRespond("");
    }
  }
  previousButtonDown = down;
}

void updateLed() {
  uint32_t now = millis();
  bool on = setupActive ? (now / 180) % 2 == 0
    : !connectionEnabled ? now % 5000 < 70
    : cameraStreamState == CameraStreamState::READY ? now % 1000 < 120 ||
      (now % 1000 > 240 && now % 1000 < 360)
    : authenticated && controlAllowed ? true
    : authenticated ? (now / 1200) % 2 == 0
    : (now / 400) % 2 == 0;
  digitalWrite(kLedPin, on ? LOW : HIGH);
}
}  // namespace

void setup() {
  Serial.begin(115200);
  pinMode(kButtonPin, INPUT_PULLUP);
  pinMode(kLedPin, OUTPUT);
  digitalWrite(kLedPin, HIGH);
  prefs.begin("gelato", false);
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  char suffix[13];
  snprintf(suffix, sizeof(suffix), "%02X%02X%02X%02X%02X%02X",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  installationId = String("inst_xiao_") + suffix;
  setupSsid = String("Gelato-Camera-") + String(suffix).substring(6);
  wifiSsid = prefs.getString("ssid");
  wifiPassword = prefs.getString("wifiPass");
  controllerOrigin = prefs.getString("origin");
  pairingCode = prefs.getString("pairCode");
  agentId = prefs.getString("agent");
  deviceId = prefs.getString("device");
  credential = prefs.getString("credential");
  lastReply = prefs.getString("lastReply");
  controlAllowed = prefs.getBool("allowed", false);
  connectionEnabled = prefs.getBool("connection", true);
  cameraStreamAllowed = prefs.getBool("streamAllowed", false);
  initCamera();
  if (!wifiSsid.length() || !controllerOrigin.length() ||
      (!credential.length() && !pairingCode.length())) {
    startSetup();
    return;
  }
  WiFi.mode(WIFI_STA);
  WiFi.begin(wifiSsid.c_str(), wifiPassword.c_str());
  uint32_t deadline = millis() + 20000;
  while (WiFi.status() != WL_CONNECTED && static_cast<int32_t>(deadline - millis()) > 0) {
    delay(100);
  }
  if (WiFi.status() != WL_CONNECTED) {
    lastError = "2.4 GHz Wi-Fi connection failed";
    startSetup();
  } else if (credential.length()) {
    Serial.println("Gelato 2.4 GHz Wi-Fi connected; paired credential present");
    startManagementWindow();
  } else {
    Serial.println("Gelato 2.4 GHz Wi-Fi connected; one-use pairing code present");
  }
}

void loop() {
  handleButton();
  updateLed();
  if (setupRequested) {
    setupRequested = false;
    startSetup();
  }
  if (managementRequested && !setupActive) {
    managementRequested = false;
    startManagementWindow();
  }
  if (setupActive) portal.handleClient();
  if (managementActive) {
    management.handleClient();
    if (static_cast<int32_t>(millis() - managementUntil) >= 0) stopManagementWindow();
  }
  if (restartRequested && static_cast<int32_t>(millis() - restartAt) >= 0) ESP.restart();
  if (!setupActive && WiFi.status() != WL_CONNECTED) {
    closeCameraStream();
    authenticated = false;
    if (control.available()) control.close();
    if (static_cast<int32_t>(millis() - nextWifiAt) >= 0) {
      WiFi.reconnect();
      nextWifiAt = millis() + 5000;
    }
    delay(100);
    return;
  }
  if (!setupActive && connectionEnabled && !control.available() &&
      static_cast<int32_t>(millis() - nextConnectAt) >= 0) {
    nextConnectAt = millis() + 5000;
    connectControl();
  }
  if (!setupActive && control.available()) {
    control.poll();
    if (authenticated && pendingCommandId.length()) {
      String id = pendingCommandId;
      String capability = pendingCapability;
      pendingCommandId = "";
      pendingCapability = "";
      if (capability == "device.describe") sendTerminal(id, true, "");
      else if (capability == "camera.capture") captureAndRespond(id);
      else sendTerminal(id, false, "Capability not advertised");
    }
    if (authenticated && millis() - lastLeaseAt >= kLeaseMs) {
      JsonDocument body;
      body["revision"] = snapshotRevision;
      sendEnvelope("lease.renew", body);
      lastLeaseAt = millis();
    }
    if (authenticated && millis() - lastMessageAt > kStaleMs) {
      authenticated = false;
      control.close();
    }
  }
  pumpCameraStream();
  delay(5);
}
