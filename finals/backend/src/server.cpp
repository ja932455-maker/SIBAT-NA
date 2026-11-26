// ============================================================================
//  SIBAT NA - backend/src/server.cpp
//  Minimal HTTP/1.1 server (Winsock, no libraries) + the JSON API.
//  Serves the SPA from the project root and exposes the C++ domain core.
// ============================================================================
#include "../include/server.hpp"
#include "../include/core.hpp"

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <random>
#include <sstream>
#include <thread>
#include <vector>

#if defined(_WIN32)
  #ifndef WIN32_LEAN_AND_MEAN
  #define WIN32_LEAN_AND_MEAN
  #endif
  #include <winsock2.h>
  #include <ws2tcpip.h>
  using socket_t = SOCKET;
  #define SIBAT_INVALID INVALID_SOCKET
  #define sibat_close closesocket
#else
  #include <arpa/inet.h>
  #include <netinet/in.h>
  #include <sys/socket.h>
  #include <unistd.h>
  using socket_t = int;
  #define SIBAT_INVALID (-1)
  #define sibat_close ::close
#endif

namespace sibat {

namespace fs = std::filesystem;

// ---------------------------------------------------------------------------
//  SMALL STRING HELPERS
// ---------------------------------------------------------------------------
static std::string lower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return s;
}
static std::string trim(const std::string& s) {
    std::size_t a = s.find_first_not_of(" \t\r\n");
    std::size_t b = s.find_last_not_of(" \t\r\n");
    return a == std::string::npos ? "" : s.substr(a, b - a + 1);
}
static std::string urlDecode(const std::string& in) {
    std::string out;
    for (std::size_t i = 0; i < in.size(); ++i) {
        if (in[i] == '%' && i + 2 < in.size()) {
            auto hex = [](char c) -> int {
                if (c >= '0' && c <= '9') return c - '0';
                if (c >= 'a' && c <= 'f') return c - 'a' + 10;
                if (c >= 'A' && c <= 'F') return c - 'A' + 10;
                return 0;
            };
            out += static_cast<char>(hex(in[i + 1]) * 16 + hex(in[i + 2]));
            i += 2;
        } else if (in[i] == '+') {
            out += ' ';
        } else {
            out += in[i];
        }
    }
    return out;
}
static std::vector<std::string> splitPath(const std::string& path) {
    std::vector<std::string> parts;
    std::string cur;
    std::istringstream is(path);
    while (std::getline(is, cur, '/')) {
        if (!cur.empty()) parts.push_back(urlDecode(cur));
    }
    return parts;
}

// ---------------------------------------------------------------------------
//  MIME TYPES
// ---------------------------------------------------------------------------
static std::string mimeFor(const std::string& path) {
    std::string ext = lower(fs::path(path).extension().string());
    if (ext == ".html") return "text/html; charset=utf-8";
    if (ext == ".css")  return "text/css; charset=utf-8";
    if (ext == ".js")   return "text/javascript; charset=utf-8";
    if (ext == ".json") return "application/json; charset=utf-8";
    if (ext == ".svg")  return "image/svg+xml";
    if (ext == ".png")  return "image/png";
    if (ext == ".jpg" || ext == ".jpeg") return "image/jpeg";
    if (ext == ".webp") return "image/webp";
    if (ext == ".ico")  return "image/x-icon";
    if (ext == ".woff2") return "font/woff2";
    if (ext == ".txt" || ext == ".md") return "text/plain; charset=utf-8";
    return "application/octet-stream";
}

// ---------------------------------------------------------------------------
//  HTTP WRAPPER
// ---------------------------------------------------------------------------
struct Request {
    std::string method;
    std::string path;
    std::string body;
};

// Forward declarations (implemented further down).
static void handleClient(App& app, const std::string& root, socket_t client);
static std::pair<int, std::string> handleApi(App& app, const Request& req);
static std::tuple<int, std::string, std::string> serveStatic(const std::string& root, const std::string& rawPath);

static std::string reasonPhrase(int code) {
    switch (code) {
    case 200: return "OK";
    case 201: return "Created";
    case 204: return "No Content";
    case 400: return "Bad Request";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 409: return "Conflict";
    case 413: return "Payload Too Large";
    case 500: return "Internal Server Error";
    default:  return "OK";
    }
}

static std::string httpResponse(int status, const std::string& body, const std::string& type) {
    std::ostringstream os;
    os << "HTTP/1.1 " << status << " " << reasonPhrase(status) << "\r\n";
    os << "Content-Type: " << type << "\r\n";
    os << "Content-Length: " << body.size() << "\r\n";
    os << "Access-Control-Allow-Origin: *\r\n";
    os << "Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS\r\n";
    os << "Access-Control-Allow-Headers: Content-Type\r\n";
    os << "Cache-Control: no-store\r\n";
    os << "Connection: close\r\n\r\n";
    os << body;
    return os.str();
}

// ---------------------------------------------------------------------------
//  SERVER
// ---------------------------------------------------------------------------
Server::Server(App& app, std::string root, int port)
    : app_(app), root_(std::move(root)), port_(port) {}

bool Server::start() {
#if defined(_WIN32)
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        std::cerr << "[sibat] WSAStartup failed\n";
        return false;
    }
#endif
    socket_t listenSock = socket(AF_INET, SOCK_STREAM, 0);
    if (listenSock == SIBAT_INVALID) {
        std::cerr << "[sibat] socket() failed\n";
        return false;
    }
    int reuse = 1;
    setsockopt(listenSock, SOL_SOCKET, SO_REUSEADDR,
               reinterpret_cast<const char*>(&reuse), sizeof(reuse));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(static_cast<unsigned short>(port_));
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

    if (bind(listenSock, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
        std::cerr << "[sibat] Could not bind 127.0.0.1:" << port_
                  << " (is another copy already running?)\n";
        sibat_close(listenSock);
        return false;
    }
    if (listen(listenSock, 64) != 0) {
        std::cerr << "[sibat] listen() failed\n";
        sibat_close(listenSock);
        return false;
    }

    std::cout << "[sibat] " << app_.state().settings.serviceName
              << " engine listening on http://127.0.0.1:" << port_ << "\n";
    std::cout << "[sibat] serving " << root_ << "\n";

    while (true) {
        sockaddr_in client{};
#if defined(_WIN32)
        int len = sizeof(client);
#else
        socklen_t len = sizeof(client);
#endif
        socket_t c = accept(listenSock, reinterpret_cast<sockaddr*>(&client), &len);
        if (c == SIBAT_INVALID) continue;
        std::thread([this, c]() {
            handleClient(app_, root_, c);
            sibat_close(c);
        }).detach();
    }
    return true;
}

void handleClient(App& app, const std::string& root, socket_t client) {
    std::string raw;
    char buf[8192];
    std::size_t headerEnd = std::string::npos;

    // 1. read headers
    while (raw.size() < 64 * 1024) {
        int n = recv(client, buf, sizeof(buf), 0);
        if (n <= 0) return;
        raw.append(buf, static_cast<std::size_t>(n));
        headerEnd = raw.find("\r\n\r\n");
        if (headerEnd != std::string::npos) break;
    }
    if (headerEnd == std::string::npos) {
        std::string res = httpResponse(400, "{\"ok\":false,\"error\":\"Bad request\"}", "application/json");
        send(client, res.data(), static_cast<int>(res.size()), 0);
        return;
    }

    std::istringstream head(raw.substr(0, headerEnd));
    Request req;
    std::string version, line;
    std::getline(head, line);
    {
        std::istringstream first(line);
        first >> req.method >> req.path >> version;
    }
    std::size_t contentLength = 0;
    while (std::getline(head, line)) {
        line = trim(line);
        std::string key = lower(line.substr(0, line.find(':')));
        std::string val = trim(line.substr(line.find(':') + 1));
        if (key == "content-length") {
            try { contentLength = static_cast<std::size_t>(std::stoul(val)); } catch (...) {}
        }
    }
    if (contentLength > 4 * 1024 * 1024) {
        std::string res = httpResponse(413, "{\"ok\":false,\"error\":\"Body too large\"}", "application/json");
        send(client, res.data(), static_cast<int>(res.size()), 0);
        return;
    }

    // 2. read body
    req.body = raw.substr(headerEnd + 4);
    while (req.body.size() < contentLength) {
        int n = recv(client, buf, sizeof(buf), 0);
        if (n <= 0) break;
        req.body.append(buf, static_cast<std::size_t>(n));
    }
    if (req.body.size() > contentLength) req.body.resize(contentLength);

    // 3. route
    std::string response;
    try {
        if (req.method == "OPTIONS") {
            response = httpResponse(204, "", "text/plain");
        } else if (req.path.rfind("/api/", 0) == 0) {
            auto [status, body] = handleApi(app, req);
            response = httpResponse(status, body, "application/json; charset=utf-8");
        } else {
            auto [status, body, type] = serveStatic(root, req.path);
            response = httpResponse(status, body, type);
        }
    } catch (const std::exception& ex) {
        std::string body = std::string("{\"ok\":false,\"error\":\"") + ex.what() + "\"}";
        response = httpResponse(500, body, "application/json");
    }

    std::size_t sent = 0;
    while (sent < response.size()) {
        int n = send(client, response.data() + sent,
                     static_cast<int>(response.size() - sent), 0);
        if (n <= 0) break;
        sent += static_cast<std::size_t>(n);
    }
}

// ---------------------------------------------------------------------------
//  STATIC FILES
// ---------------------------------------------------------------------------
std::tuple<int, std::string, std::string> serveStatic(const std::string& root, const std::string& rawPath) {
    std::string path = rawPath;
    std::size_t q = path.find('?');
    if (q != std::string::npos) path = path.substr(0, q);
    if (path.empty() || path == "/") path = "/index.html";
    if (path.find("..") != std::string::npos) {
        return { 403, "Forbidden", "text/plain" };
    }
    fs::path full = fs::path(root) / path.substr(1);
    std::error_code ec;
    if (!fs::exists(full, ec) || !fs::is_regular_file(full, ec)) {
        // graceful fallback: unknown non-file paths show the SPA
        if (path.find('.') == std::string::npos) {
            full = fs::path(root) / "index.html";
        } else {
            return { 404, "Not found: " + path, "text/plain" };
        }
    }
    std::ifstream in(full, std::ios::binary);
    if (!in.good()) return { 404, "Not found", "text/plain" };
    std::ostringstream ss;
    ss << in.rdbuf();
    return { 200, ss.str(), mimeFor(path) };
}

// ---------------------------------------------------------------------------
//  API
// ---------------------------------------------------------------------------
static std::pair<int, std::string> apiError(int code, const std::string& msg) {
    Json j = Json::object();
    j["ok"] = false;
    j["error"] = msg;
    return { code, j.dump() };
}

static std::pair<int, std::string> apiOk(const Json& extra) {
    Json j = extra;
    j["ok"] = true;
    return { 200, j.dump() };
}

static std::string bodyString(const Json& b, const char* key, const std::string& fallback = "") {
    return b.has(key) ? b.at(key).asString(fallback) : fallback;
}
static double bodyNumber(const Json& b, const char* key, double fallback = 0) {
    return b.has(key) ? b.at(key).asDouble(fallback) : fallback;
}
static int bodyInt(const Json& b, const char* key, int fallback = 0) {
    return b.has(key) ? static_cast<int>(b.at(key).asInt(fallback)) : fallback;
}

// Copy optional account fields from a JSON body onto an Account.
static void applyAccountBody(Account& a, const Json& b) {
    auto set = [&](const char* key, std::string& target) {
        if (b.has(key)) target = b.at(key).asString();
    };
    set("role", a.role);
    set("name", a.name);
    set("email", a.email);
    set("phone", a.phone);
    set("emergency", a.emergency);
    set("plate", a.plate);
    set("vehicle", a.vehicle);
    set("license", a.license);
    set("nbi", a.nbi);
    set("orcr", a.orcr);
    set("ltfrb", a.ltfrb);
    set("otherDocs", a.otherDocs);
    set("idImage", a.idImage);
    set("status", a.status);
    if (b.has("lat")) a.lat = bodyNumber(b, "lat", a.lat);
    if (b.has("lng")) a.lng = bodyNumber(b, "lng", a.lng);
}

std::pair<int, std::string> handleApi(App& app_, const Request& req) {
    std::vector<std::string> p = splitPath(req.path); // ["api", ...]
    if (p.empty() || p[0] != "api") return apiError(404, "Unknown endpoint");
    std::string method = req.method;

    Json body = Json::object();
    if (!req.body.empty()) {
        try { body = Json::parse(req.body); }
        catch (const std::exception&) { return apiError(400, "Body is not valid JSON"); }
    }

    // ----- health / state ---------------------------------------------------
    if (p.size() == 2 && p[1] == "health" && method == "GET") {
        Json j = Json::object();
        j["service"] = "sibat-na";
        j["version"] = "1.0.0";
        j["engine"] = "c++";
        j["time"] = isoNow();
        return apiOk(j);
    }
    if (p.size() == 2 && p[1] == "state" && method == "GET") {
        std::lock_guard<std::mutex> lock(app_.mutex());
        Json j = Json::object();
        j["state"] = stateJson(app_.state(), true);
        j["serverTime"] = isoNow();
        return apiOk(j);
    }
    if (p.size() == 2 && p[1] == "stats" && method == "GET") {
        std::lock_guard<std::mutex> lock(app_.mutex());
        Json j = Json::object();
        Json stats = statsJson(app_.state());
        j["stats"] = stats;
        return apiOk(j);
    }
    if (p.size() == 2 && p[1] == "config" && method == "GET") {
        std::lock_guard<std::mutex> lock(app_.mutex());
        Json j = Json::object();
        j["settings"] = settingsJson(app_.state());
        j["ui"] = uiJson(app_.state());
        return apiOk(j);
    }
    if (p.size() == 2 && p[1] == "config" && method == "POST") {
        std::lock_guard<std::mutex> lock(app_.mutex());
        AppState& st = app_.state();
        if (body.has("settings")) {
            const Json& s = body.at("settings");
            st.settings.baseFare = bodyNumber(s, "baseFare", st.settings.baseFare);
            st.settings.includedKm = bodyNumber(s, "includedKm", st.settings.includedKm);
            st.settings.perKm = bodyNumber(s, "perKm", st.settings.perKm);
            st.settings.matchDelaySeconds = bodyInt(s, "matchDelaySeconds", st.settings.matchDelaySeconds);
            st.settings.dispatchMode = bodyString(s, "dispatchMode", st.settings.dispatchMode);
            st.settings.serviceName = bodyString(s, "serviceName", st.settings.serviceName);
        }
        if (body.has("ui") && body.at("ui").isObject()) {
            for (const auto& kv : body.at("ui").items()) st.ui[kv.first] = kv.second.asString();
        }
        app_.save();
        Json j = Json::object();
        j["settings"] = settingsJson(st);
        j["ui"] = uiJson(st);
        return apiOk(j);
    }
    if (p.size() == 2 && p[1] == "reset" && method == "POST") {
        std::lock_guard<std::mutex> lock(app_.mutex());
        app_.state() = seedState();
        app_.save();
        return apiOk(Json::object());
    }

    // ----- accounts ---------------------------------------------------------
    if (p.size() == 2 && p[1] == "accounts") {
        if (method == "GET") {
            std::lock_guard<std::mutex> lock(app_.mutex());
            Json arr = Json::array();
            for (const auto& a : app_.state().accounts) arr.push_back(accountJson(a, true));
            Json j = Json::object();
            j["accounts"] = arr;
            return apiOk(j);
        }
        if (method == "POST") {
            std::lock_guard<std::mutex> lock(app_.mutex());
            AppState& st = app_.state();
            std::string id = bodyString(body, "id");
            Account* existing = id.empty() ? nullptr : st.account(id);
            if (existing) {
                applyAccountBody(*existing, body);
                app_.save();
                Json j = Json::object();
                j["account"] = accountJson(*existing, true);
                return apiOk(j);
            }
            Account a;
            a.id = id.empty() ? st.nextId(bodyString(body, "role") == "driver" ? "DRV" : "PAS") : id;
            a.role = bodyString(body, "role", "passenger");
            applyAccountBody(a, body);
            a.createdAt = nowMillis();
            st.accounts.push_back(a);
            app_.save();
            Json j = Json::object();
            j["account"] = accountJson(a, true);
            return apiOk(j);
        }
    }
    if (p.size() == 3 && p[1] == "accounts" && method == "GET") {
        std::lock_guard<std::mutex> lock(app_.mutex());
        Account* a = app_.state().account(p[2]);
        if (!a) return apiError(404, "Account not found");
        Json j = Json::object();
        j["account"] = accountJson(*a, true);
        return apiOk(j);
    }
    if (p.size() == 4 && p[1] == "accounts" && p[3] == "status" && method == "POST") {
        std::lock_guard<std::mutex> lock(app_.mutex());
        Account* a = app_.state().account(p[2]);
        if (!a) return apiError(404, "Account not found");
        std::string status = bodyString(body, "status", "offline");
        if (status != "online" && status != "offline" && status != "busy") {
            return apiError(400, "status must be online/offline/busy");
        }
        if (status == "offline" && a->status == "busy") {
            return apiError(409, "Finish or cancel the active trip first");
        }
        a->status = status;
        app_.save();
        Json j = Json::object();
        j["account"] = accountJson(*a, true);
        return apiOk(j);
    }

    // ----- rides ------------------------------------------------------------
    if (p.size() == 2 && p[1] == "rides") {
        if (method == "GET") {
            std::lock_guard<std::mutex> lock(app_.mutex());
            Json arr = Json::array();
            for (const auto& r : app_.state().rides) arr.push_back(rideJson(app_.state(), r));
            Json j = Json::object();
            j["rides"] = arr;
            return apiOk(j);
        }
        if (method == "POST") {
            std::lock_guard<std::mutex> lock(app_.mutex());
            AppState& st = app_.state();
            std::string pickup = bodyString(body, "pickupLabel");
            std::string dest = bodyString(body, "destLabel");
            if (pickup.empty() || dest.empty()) return apiError(400, "Pickup and destination are required");
            if (bodyNumber(body, "pickupLat") == 0 || bodyNumber(body, "destLat") == 0) {
                return apiError(400, "Pickup and destination coordinates are required");
            }
            Ride r;
            r.id = st.nextId("RIDE");
            r.code = "SBT-" + std::to_string(1000 + (st.seq % 9000));
            r.passengerId = bodyString(body, "passengerId", "GUEST");
            r.passengerName = bodyString(body, "passengerName", "Passenger");
            r.phone = bodyString(body, "phone");
            r.pickupLabel = pickup;
            r.destLabel = dest;
            r.pickupArea = bodyString(body, "pickupArea", pickup);
            r.destArea = bodyString(body, "destArea", dest);
            r.pickupLat = bodyNumber(body, "pickupLat");
            r.pickupLng = bodyNumber(body, "pickupLng");
            r.destLat = bodyNumber(body, "destLat");
            r.destLng = bodyNumber(body, "destLng");
            double km = bodyNumber(body, "distanceKm", 0);
            if (km <= 0) km = haversineKm(r.pickupLat, r.pickupLng, r.destLat, r.destLng);
            r.distanceKm = std::round(km * 10.0) / 10.0;
            r.fare = computeFare(r.distanceKm, st.settings);
            r.seats = std::max(1, bodyInt(body, "seats", 1));
            r.queueKey = makeQueueKey(r.pickupArea, r.destArea);
            r.status = "pending";
            r.createdAt = nowMillis();
            st.rides.push_back(r);
            app_.save();
            Json j = Json::object();
            j["ride"] = rideJson(st, *st.ride(r.id));
            return apiOk(j);
        }
    }
    if (p.size() == 3 && p[1] == "rides" && method == "GET") {
        std::lock_guard<std::mutex> lock(app_.mutex());
        Ride* r = app_.state().ride(p[2]);
        if (!r) return apiError(404, "Ride not found");
        Json j = Json::object();
        j["ride"] = rideJson(app_.state(), *r);
        return apiOk(j);
    }
    if (p.size() == 4 && p[1] == "rides" && p[3] == "cancel" && method == "POST") {
        std::lock_guard<std::mutex> lock(app_.mutex());
        std::string err;
        if (!cancelRide(app_.state(), p[2], &err)) {
            if (err == "Ride not found") return apiError(404, err);
            return apiError(409, err);
        }
        app_.save();
        Json j = Json::object();
        j["ride"] = rideJson(app_.state(), *app_.state().ride(p[2]));
        return apiOk(j);
    }

    // ----- driver actions ---------------------------------------------------
    if (p.size() == 4 && p[1] == "drivers" && p[3] == "status" && method == "POST") {
        std::lock_guard<std::mutex> lock(app_.mutex());
        Account* d = app_.state().account(p[2]);
        if (!d || d->role != "driver") return apiError(404, "Driver not found");
        std::string status = bodyString(body, "status", "offline");
        if (status != "online" && status != "offline") return apiError(400, "status must be online/offline");
        if (status == "offline" && d->status == "busy") {
            return apiError(409, "Finish the active trip before going offline");
        }
        d->status = status;
        app_.save();
        Json j = Json::object();
        j["account"] = accountJson(*d, true);
        return apiOk(j);
    }
    if (p.size() == 3 && p[1] == "drivers" && method == "GET") {
        std::lock_guard<std::mutex> lock(app_.mutex());
        Account* d = app_.state().account(p[2]);
        if (!d || d->role != "driver") return apiError(404, "Driver not found");
        Json j = Json::object();
        j["account"] = accountJson(*d, true);
        return apiOk(j);
    }
    if (p.size() == 4 && p[1] == "drivers" && p[3] == "match" && method == "POST") {
        std::lock_guard<std::mutex> lock(app_.mutex());
        AppState& st = app_.state();
        Account* d = st.account(p[2]);
        if (!d || d->role != "driver") return apiError(404, "Driver not found");
        if (d->status == "offline") return apiError(409, "Go online first");
        if (d->status == "busy") return apiError(409, "You already have an active trip");

        // Prefer a pending ride whose offer can go to this driver; else take the oldest in the whole queue.
        Ride* pick = nullptr;
        for (auto& r : st.rides) {
            if (r.status != "pending") continue;
            Account* best = bestDriverFor(st, r);
            if (best && best->id == d->id) {
                if (!pick || earlierRide(r, *pick)) pick = &r;
            }
        }
        if (!pick) pick = oldestPending(st);
        if (!pick) {
            // No queued passenger: sometimes a random walk-in appears, sometimes not.
            std::mt19937 rng(static_cast<unsigned>(std::random_device{}()));
            std::bernoulli_distribution coin(0.5);
            if (coin(rng)) {
                Ride* walkIn = spawnWalkInPassenger(st, *d);
                if (walkIn) {
                    app_.save();
                    Json j = Json::object();
                    j["ride"] = rideJson(st, *walkIn);
                    return apiOk(j);
                }
            }
            return apiError(404, "No passenger nearby right now. Try again.");
        }

        // Demo dispatch: force the offer onto THIS driver so the 3-second match
        // sequence in the driver UI always has something to show.
        pick->status = "offered";
        pick->driverId = d->id;
        pick->driverName = d->name;
        pick->plate = d->plate;
        pick->vehicle = d->vehicle;
        pick->matchedAt = nowMillis();
        d->status = "busy";
        app_.save();
        Json j = Json::object();
        j["ride"] = rideJson(st, *pick);
        return apiOk(j);
    }
    if (p.size() == 4 && (p[3] == "accept" || p[3] == "reject") && p[1] == "drivers" && method == "POST") {
        std::lock_guard<std::mutex> lock(app_.mutex());
        std::string rideId = bodyString(body, "rideId");
        std::string err;
        bool good = p[3] == "accept"
            ? acceptRide(app_.state(), p[2], rideId, &err)
            : rejectRide(app_.state(), p[2], rideId, &err);
        if (!good) return apiError(409, err.empty() ? "Could not update ride" : err);
        app_.save();
        Json j = Json::object();
        j["ride"] = rideJson(app_.state(), *app_.state().ride(rideId));
        j["driver"] = accountJson(*app_.state().account(p[2]), false);
        return apiOk(j);
    }
    if (p.size() == 4 && p[3] == "phase" && p[1] == "drivers" && method == "POST") {
        std::lock_guard<std::mutex> lock(app_.mutex());
        std::string rideId = bodyString(body, "rideId");
        std::string phase = bodyString(body, "phase");
        std::string err;
        if (!advancePhase(app_.state(), p[2], rideId, phase, &err)) {
            return apiError(409, err.empty() ? "Could not advance ride" : err);
        }
        app_.save();
        Json j = Json::object();
        j["ride"] = rideJson(app_.state(), *app_.state().ride(rideId));
        j["driver"] = accountJson(*app_.state().account(p[2]), false);
        return apiOk(j);
    }
    if (p.size() == 4 && p[3] == "location" && p[1] == "drivers" && method == "POST") {
        std::lock_guard<std::mutex> lock(app_.mutex());
        Account* d = app_.state().account(p[2]);
        if (!d || d->role != "driver") return apiError(404, "Driver not found");
        d->lat = bodyNumber(body, "lat", d->lat);
        d->lng = bodyNumber(body, "lng", d->lng);
        app_.save();
        return apiOk(Json::object());
    }

    // ----- operations -------------------------------------------------------
    if (p.size() == 3 && p[1] == "ops" && p[2] == "serve-next" && method == "POST") {
        std::lock_guard<std::mutex> lock(app_.mutex());
        std::string msg = serveNext(app_.state());
        app_.save();
        Json j = Json::object();
        j["message"] = msg;
        j["stats"] = statsJson(app_.state());
        return apiOk(j);
    }
    if (p.size() == 3 && p[1] == "ops" && p[2] == "demo-advance" && method == "POST") {
        std::lock_guard<std::mutex> lock(app_.mutex());
        std::string msg;
        Ride* ride = demoAdvance(app_.state(), bodyString(body, "rideId"), &msg);
        if (!ride) return apiError(404, msg.empty() ? "Ride not found" : msg);
        app_.save();
        Json j = Json::object();
        j["ride"] = rideJson(app_.state(), *ride);
        j["message"] = msg;
        return apiOk(j);
    }
    if (p.size() == 3 && p[1] == "ops" && p[2] == "simulate" && method == "POST") {
        std::lock_guard<std::mutex> lock(app_.mutex());
        int steps = bodyInt(body, "steps", 5);
        bool spawn = body.has("spawn") ? body.at("spawn").asBool(true) : true;
        std::string msg = simulate(app_.state(), steps, spawn);
        app_.save();
        Json j = Json::object();
        j["message"] = msg;
        j["stats"] = statsJson(app_.state());
        j["state"] = stateJson(app_.state(), true);
        return apiOk(j);
    }

    // ----- admin CRUD -------------------------------------------------------
    if (p.size() >= 3 && p[1] == "admin") {
        std::lock_guard<std::mutex> lock(app_.mutex());
        AppState& st = app_.state();
        std::string entity = p[2];
        std::string id = p.size() >= 4 ? p[3] : "";

        auto listEntity = [&]() -> Json {
            Json arr = Json::array();
            if (entity == "drivers" || entity == "passengers") {
                std::string role = entity == "drivers" ? "driver" : "passenger";
                for (const auto& a : st.accounts) if (a.role == role) arr.push_back(accountJson(a, true));
            } else if (entity == "rides") {
                for (const auto& r : st.rides) arr.push_back(rideJson(st, r));
            } else if (entity == "routes") {
                for (const auto& r : st.routes) {
                    Json x = Json::object();
                    x["id"] = r.id; x["name"] = r.name; x["from"] = r.from; x["to"] = r.to;
                    x["baseFare"] = r.baseFare; x["perKm"] = r.perKm; x["km"] = r.km; x["active"] = r.active;
                    arr.push_back(x);
                }
            } else if (entity == "locations") {
                for (const auto& l : st.locations) {
                    Json x = Json::object();
                    x["id"] = l.id; x["name"] = l.name; x["lat"] = l.lat; x["lng"] = l.lng;
                    x["zone"] = l.zone; x["active"] = l.active;
                    arr.push_back(x);
                }
            } else if (entity == "texts") {
                for (const auto& kv : st.ui) {
                    Json x = Json::object();
                    x["id"] = kv.first; x["key"] = kv.first; x["value"] = kv.second;
                    arr.push_back(x);
                }
            }
            return arr;
        };

        if (method == "GET" && id.empty()) {
            Json j = Json::object();
            j["items"] = listEntity();
            return apiOk(j);
        }
        if (entity == "rides") {
            if (method == "DELETE" && !id.empty()) {
                auto it = std::remove_if(st.rides.begin(), st.rides.end(),
                                         [&](const Ride& r) { return r.id == id; });
                if (it == st.rides.end()) return apiError(404, "Ride not found");
                st.rides.erase(it, st.rides.end());
                app_.save();
                return apiOk(Json::object());
            }
            if (method == "PUT" && !id.empty()) {
                Ride* r = st.ride(id);
                if (!r) return apiError(404, "Ride not found");
                if (body.has("fare")) r->fare = bodyNumber(body, "fare", r->fare);
                if (body.has("status")) r->status = bodyString(body, "status", r->status);
                if (body.has("seats")) r->seats = bodyInt(body, "seats", r->seats);
                app_.save();
                Json j = Json::object();
                j["item"] = rideJson(st, *r);
                return apiOk(j);
            }
        }
        if (entity == "routes") {
            if (method == "POST") {
                RouteCfg r;
                r.id = st.nextId("RTE");
                r.name = bodyString(body, "name", "New route");
                r.from = bodyString(body, "from");
                r.to = bodyString(body, "to");
                r.baseFare = bodyNumber(body, "baseFare", st.settings.baseFare);
                r.perKm = bodyNumber(body, "perKm", st.settings.perKm);
                r.km = bodyNumber(body, "km", 5);
                r.active = body.has("active") ? body.at("active").asBool(true) : true;
                if (r.name.empty()) return apiError(400, "Route name is required");
                st.routes.push_back(r);
                app_.save();
                return apiOk(Json::object());
            }
            if (method == "PUT" && !id.empty()) {
                RouteCfg* r = st.route(id);
                if (!r) return apiError(404, "Route not found");
                if (body.has("name")) r->name = bodyString(body, "name", r->name);
                if (body.has("from")) r->from = bodyString(body, "from", r->from);
                if (body.has("to")) r->to = bodyString(body, "to", r->to);
                if (body.has("baseFare")) r->baseFare = bodyNumber(body, "baseFare", r->baseFare);
                if (body.has("perKm")) r->perKm = bodyNumber(body, "perKm", r->perKm);
                if (body.has("km")) r->km = bodyNumber(body, "km", r->km);
                if (body.has("active")) r->active = body.at("active").asBool(r->active);
                app_.save();
                return apiOk(Json::object());
            }
            if (method == "DELETE" && !id.empty()) {
                auto it = std::remove_if(st.routes.begin(), st.routes.end(),
                                         [&](const RouteCfg& r) { return r.id == id; });
                if (it == st.routes.end()) return apiError(404, "Route not found");
                st.routes.erase(it, st.routes.end());
                app_.save();
                return apiOk(Json::object());
            }
        }
        if (entity == "locations") {
            if (method == "POST") {
                LocationCfg l;
                l.id = st.nextId("LOC");
                l.name = bodyString(body, "name", "New location");
                l.lat = bodyNumber(body, "lat", 14.5995);
                l.lng = bodyNumber(body, "lng", 120.9842);
                l.zone = bodyString(body, "zone", "Manila");
                l.active = body.has("active") ? body.at("active").asBool(true) : true;
                if (l.name.empty()) return apiError(400, "Location name is required");
                st.locations.push_back(l);
                app_.save();
                return apiOk(Json::object());
            }
            if (method == "PUT" && !id.empty()) {
                LocationCfg* l = st.location(id);
                if (!l) return apiError(404, "Location not found");
                if (body.has("name")) l->name = bodyString(body, "name", l->name);
                if (body.has("lat")) l->lat = bodyNumber(body, "lat", l->lat);
                if (body.has("lng")) l->lng = bodyNumber(body, "lng", l->lng);
                if (body.has("zone")) l->zone = bodyString(body, "zone", l->zone);
                if (body.has("active")) l->active = body.at("active").asBool(l->active);
                app_.save();
                return apiOk(Json::object());
            }
            if (method == "DELETE" && !id.empty()) {
                auto it = std::remove_if(st.locations.begin(), st.locations.end(),
                                         [&](const LocationCfg& l) { return l.id == id; });
                if (it == st.locations.end()) return apiError(404, "Location not found");
                st.locations.erase(it, st.locations.end());
                app_.save();
                return apiOk(Json::object());
            }
        }
        if (entity == "texts") {
            if (method == "POST" || (method == "PUT" && !id.empty())) {
                std::string key = bodyString(body, "key", id);
                std::string value = bodyString(body, "value");
                if (key.empty()) return apiError(400, "Text key is required");
                st.ui[key] = value;
                app_.save();
                return apiOk(Json::object());
            }
            if (method == "DELETE" && !id.empty()) {
                if (!st.ui.erase(id)) return apiError(404, "Text key not found");
                app_.save();
                return apiOk(Json::object());
            }
        }
        if (entity == "drivers" || entity == "passengers") {
            if (method == "POST" || (method == "PUT" && !id.empty())) {
                Account* a = id.empty() ? nullptr : st.account(id);
                bool created = false;
                if (!a) {
                    Account fresh;
                    fresh.id = id.empty() ? st.nextId(entity == "drivers" ? "DRV" : "PAS") : id;
                    fresh.role = entity == "drivers" ? "driver" : "passenger";
                    fresh.createdAt = nowMillis();
                    st.accounts.push_back(fresh);
                    a = &st.accounts.back();
                    created = true;
                }
                applyAccountBody(*a, body);
                if (entity == "drivers") a->role = "driver";
                if (entity == "passengers") a->role = "passenger";
                app_.save();
                Json j = Json::object();
                j["item"] = accountJson(*a, true);
                j["created"] = created;
                return apiOk(j);
            }
            if (method == "DELETE" && !id.empty()) {
                auto it = std::remove_if(st.accounts.begin(), st.accounts.end(),
                                         [&](const Account& a) { return a.id == id && a.role == entity.substr(0, entity.size() - 1); });
                if (it == st.accounts.end()) return apiError(404, "Account not found");
                st.accounts.erase(it, st.accounts.end());
                app_.save();
                return apiOk(Json::object());
            }
        }
        return apiError(405, "Unsupported admin operation");
    }

    return apiError(404, "Unknown endpoint " + req.method + " " + req.path);
}

} // namespace sibat
