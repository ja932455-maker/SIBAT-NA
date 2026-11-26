// ============================================================================
//  SIBAT NA - backend/src/core.cpp
//  Fare rules, shared queue, dispatch, ride phases, simulation, persistence.
//  DEMO PROJECT: all data is fictional and every "account" is local.
// ============================================================================
#include "../include/core.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <ctime>
#include <fstream>
#include <iomanip>
#include <random>
#include <sstream>
#include <stdexcept>

namespace sibat {

// ===========================================================================
//  TIME HELPERS
// ===========================================================================
long long nowMillis() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

std::string isoNow() {
    std::time_t t = std::time(nullptr);
    std::tm tm{};
#if defined(_WIN32)
    gmtime_s(&tm, &t);
#else
    gmtime_r(&t, &tm);
#endif
    std::ostringstream os;
    os << std::put_time(&tm, "%Y-%m-%dT%H:%M:%SZ");
    return os.str();
}

// ===========================================================================
//  APPSTATE LOOKUPS
// ===========================================================================
std::string AppState::nextId(const std::string& prefix) {
    ++seq;
    return prefix + "-" + std::to_string(seq);
}

Account* AppState::account(const std::string& id) {
    for (auto& a : accounts) if (a.id == id) return &a;
    return nullptr;
}
Ride* AppState::ride(const std::string& id) {
    for (auto& r : rides) if (r.id == id) return &r;
    return nullptr;
}
RouteCfg* AppState::route(const std::string& id) {
    for (auto& r : routes) if (r.id == id) return &r;
    return nullptr;
}
LocationCfg* AppState::location(const std::string& id) {
    for (auto& l : locations) if (l.id == id) return &l;
    return nullptr;
}

// ===========================================================================
//  GEOMETRY + FARE
// ===========================================================================
double haversineKm(double lat1, double lng1, double lat2, double lng2) {
    constexpr double kEarthKm = 6371.0;
    constexpr double kDeg = 3.14159265358979323846 / 180.0;
    double dLat = (lat2 - lat1) * kDeg;
    double dLng = (lng2 - lng1) * kDeg;
    double a = std::sin(dLat / 2) * std::sin(dLat / 2) +
               std::cos(lat1 * kDeg) * std::cos(lat2 * kDeg) *
               std::sin(dLng / 2) * std::sin(dLng / 2);
    return 2 * kEarthKm * std::asin(std::min(1.0, std::sqrt(a)));
}

// Fare = base fare covering the first `includedKm`, then per-km. Rounded to cents.
double computeFare(double km, const Settings& s) {
    double billable = std::max(0.0, km - s.includedKm);
    double fare = s.baseFare + billable * s.perKm;
    return std::round(std::max(fare, s.baseFare) * 100.0) / 100.0;
}

std::string makeQueueKey(const std::string& pickupArea, const std::string& destArea) {
    auto norm = [](std::string v) {
        std::string out;
        for (char c : v) {
            if (std::isalnum(static_cast<unsigned char>(c))) out += static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
            else if (c == ' ') out += '-';
        }
        std::size_t a = out.find_first_not_of('-');
        std::size_t b = out.find_last_not_of('-');
        if (a == std::string::npos) return std::string("unzoned");
        return out.substr(a, b - a + 1);
    };
    return norm(pickupArea.empty() ? "shared" : pickupArea) + ">" +
           norm(destArea.empty() ? "shared" : destArea);
}

// ===========================================================================
//  QUEUE + DISPATCH
// ===========================================================================
bool earlierRide(const Ride& a, const Ride& b) {
    if (a.createdAt != b.createdAt) return a.createdAt < b.createdAt;
    return a.id < b.id;
}

int queuePosition(const AppState& st, const Ride& r) {
    if (r.status != "pending") return 0;
    std::vector<const Ride*> peers;
    for (const auto& other : st.rides) {
        if (other.status != "pending") continue;
        if (other.queueKey != r.queueKey) continue;
        peers.push_back(&other);
    }
    std::sort(peers.begin(), peers.end(), [](const Ride* a, const Ride* b) { return earlierRide(*a, *b); });
    for (std::size_t i = 0; i < peers.size(); ++i) {
        if (peers[i]->id == r.id) return static_cast<int>(i) + 1;
    }
    return 0;
}

Ride* oldestPending(AppState& st, const std::string& queueKey) {
    Ride* best = nullptr;
    for (auto& r : st.rides) {
        if (r.status != "pending") continue;
        if (!queueKey.empty() && r.queueKey != queueKey) continue;
        if (!best || earlierRide(r, *best)) best = &r;
    }
    return best;
}

Account* bestDriverFor(AppState& st, const Ride& r) {
    Account* best = nullptr;
    double bestScore = 1e18;
    for (auto& a : st.accounts) {
        if (a.role != "driver") continue;
        if (a.status != "online") continue;
        double d = haversineKm(a.lat, a.lng, r.pickupLat, r.pickupLng);
        // prefer closer drivers, then drivers with fewer completed trips (fairness)
        double score = d + a.trips * 0.02;
        if (score < bestScore) { bestScore = score; best = &a; }
    }
    return best;
}

Ride* offerRide(AppState& st, Ride& r, std::string* reason) {
    if (r.status != "pending") {
        if (reason) *reason = "Ride is not waiting in the queue";
        return nullptr;
    }
    Account* driver = bestDriverFor(st, r);
    if (!driver) {
        if (reason) *reason = "No driver is online right now";
        return nullptr;
    }
    r.status = "offered";
    r.driverId = driver->id;
    r.driverName = driver->name;
    r.plate = driver->plate;
    r.vehicle = driver->vehicle;
    r.matchedAt = nowMillis();
    driver->status = "busy";
    return &r;
}

std::string serveNext(AppState& st) {
    Ride* next = oldestPending(st);
    if (!next) return "Queue is empty";
    std::string reason;
    Ride* offered = offerRide(st, *next, &reason);
    if (!offered) return "No dispatch: " + reason;
    return "Offered " + offered->code + " to " + offered->driverName;
}

Ride* demoAdvance(AppState& st, const std::string& rideId, std::string* message) {
    Ride* ride = st.ride(rideId);
    if (!ride) {
        if (message) *message = "Ride not found";
        return nullptr;
    }
    if (ride->status == "completed" || ride->status == "cancelled") {
        if (message) *message = "Ride already closed";
        return ride;
    }
    std::string err;

    if (ride->status == "pending") {
        Account* driver = bestDriverFor(st, *ride);
        if (!driver) {
            // For the demo, put the nearest driver online so the passenger sees progress.
            double bestDistance = 1e18;
            for (auto& account : st.accounts) {
                if (account.role != "driver") continue;
                if (account.status == "busy") continue;
                double distance = haversineKm(account.lat, account.lng, ride->pickupLat, ride->pickupLng);
                if (distance < bestDistance) { bestDistance = distance; driver = &account; }
            }
            if (driver) driver->status = "online";
        }
        if (!driver) {
            if (message) *message = "No driver available";
            return ride;
        }
        ride->status = "offered";
        ride->driverId = driver->id;
        ride->driverName = driver->name;
        ride->plate = driver->plate;
        ride->vehicle = driver->vehicle;
        ride->matchedAt = nowMillis();
        driver->status = "busy";
        if (message) *message = "offered";
        return ride;
    }

    if (ride->status == "offered") {
        if (!acceptRide(st, ride->driverId, ride->id, &err)) {
            if (message) *message = err;
            return ride;
        }
        if (message) *message = "arriving";
        return ride;
    }

    std::string next;
    if (ride->status == "arriving" || ride->status == "at_pickup") {
        // The demo skips the separate at-pickup stop so each visible step is 3s.
        ride->status = "on_trip";
        Account* driver = st.account(ride->driverId);
        if (driver) { driver->lat = ride->pickupLat; driver->lng = ride->pickupLng; }
        if (message) *message = "on_trip";
        return ride;
    }
    if (ride->status == "on_trip") next = "completed";
    if (next.empty()) {
        if (message) *message = "No next phase";
        return ride;
    }
    if (!advancePhase(st, ride->driverId, ride->id, next, &err)) {
        if (message) *message = err;
        return ride;
    }
    if (message) *message = next;
    return ride;
}

Ride* spawnWalkInPassenger(AppState& st, Account& driver) {
    if (st.locations.empty()) return nullptr;

    static const char* names[] = {
        "Ariel Santos", "Bea Lopez", "Carlo Mendoza", "Dina Reyes", "Enzo Garcia"
    };
    std::mt19937 rng(static_cast<unsigned>(nowMillis() ^ (st.seq * 2654435761u)));
    std::uniform_int_distribution<std::size_t> locationPick(0, st.locations.size() - 1);

    // Pickup: the saved location closest to the driver. Destination: another random stop.
    const LocationCfg* pickup = &st.locations[0];
    double best = 1e18;
    for (auto& location : st.locations) {
        double distance = haversineKm(driver.lat, driver.lng, location.lat, location.lng);
        if (distance < best) { best = distance; pickup = &location; }
    }
    const LocationCfg* destination = &st.locations[locationPick(rng)];
    if (destination->id == pickup->id) {
        destination = &st.locations[(locationPick(rng) + 1) % st.locations.size()];
    }

    Ride ride;
    ride.id = st.nextId("RIDE");
    ride.code = "SBT-" + std::to_string(1000 + (st.seq % 9000));
    ride.passengerId = "WALKIN";
    ride.passengerName = names[std::uniform_int_distribution<int>(0, 4)(rng)];
    ride.phone = "09170000000";
    ride.pickupLabel = pickup->name;
    ride.destLabel = destination->name;
    ride.pickupArea = pickup->zone;
    ride.destArea = destination->zone;
    ride.pickupLat = pickup->lat;
    ride.pickupLng = pickup->lng;
    ride.destLat = destination->lat;
    ride.destLng = destination->lng;
    double km = haversineKm(ride.pickupLat, ride.pickupLng, ride.destLat, ride.destLng);
    ride.distanceKm = std::round(km * 10.0) / 10.0;
    ride.fare = computeFare(ride.distanceKm, st.settings);
    ride.seats = 1;
    ride.queueKey = makeQueueKey(ride.pickupArea, ride.destArea);
    ride.status = "offered";
    ride.driverId = driver.id;
    ride.driverName = driver.name;
    ride.plate = driver.plate;
    ride.vehicle = driver.vehicle;
    ride.createdAt = nowMillis();
    ride.matchedAt = ride.createdAt;
    st.rides.push_back(ride);
    driver.status = "busy";
    return &st.rides.back();
}

bool acceptRide(AppState& st, const std::string& driverId, const std::string& rideId, std::string* err) {
    Ride* r = st.ride(rideId);
    Account* d = st.account(driverId);
    if (!r || !d) { if (err) *err = "Ride or driver not found"; return false; }
    if (r->status != "offered" || r->driverId != driverId) { if (err) *err = "This offer is no longer yours"; return false; }
    r->status = "arriving";
    r->matchedAt = nowMillis();
    d->status = "busy";
    return true;
}

bool rejectRide(AppState& st, const std::string& driverId, const std::string& rideId, std::string* err) {
    Ride* r = st.ride(rideId);
    Account* d = st.account(driverId);
    if (!r || !d) { if (err) *err = "Ride or driver not found"; return false; }
    if (r->status != "offered" || r->driverId != driverId) { if (err) *err = "This offer is no longer yours"; return false; }
    // A rejected walk-in was only generated for this demo attempt — cancel it
    // instead of leaving it in the queue, so the next search can be random again.
    if (r->passengerId == "WALKIN") {
        r->status = "cancelled";
        r->matchedAt = 0;
        if (d->status == "busy") d->status = "online";
        return true;
    }
    r->status = "pending";
    r->driverId.clear();
    r->driverName.clear();
    r->plate.clear();
    r->vehicle.clear();
    r->matchedAt = 0;
    if (d->status == "busy") d->status = "online";
    return true;
}

static void completeRide(AppState& st, Ride& r, Account* d) {
    r.status = "completed";
    r.completedAt = nowMillis();
    if (d) {
        d->earnings = std::round((d->earnings + r.fare * 0.8) * 100.0) / 100.0; // 80% driver share
        d->trips += 1;
        d->status = "online";
        d->lat = r.destLat;
        d->lng = r.destLng;
    }
    (void)st;
}

static bool allowedNext(const std::string& from, const std::string& to) {
    if (from == "arriving"   && to == "at_pickup") return true;
    if (from == "at_pickup"  && to == "on_trip")   return true;
    if (from == "on_trip"    && to == "completed") return true;
    return false;
}

bool advancePhase(AppState& st, const std::string& driverId, const std::string& rideId,
                  const std::string& phase, std::string* err) {
    Ride* r = st.ride(rideId);
    Account* d = st.account(driverId);
    if (!r || !d) { if (err) *err = "Ride or driver not found"; return false; }
    if (r->driverId != driverId) { if (err) *err = "This ride is assigned to another driver"; return false; }
    if (!allowedNext(r->status, phase)) {
        if (err) *err = "Cannot move from " + r->status + " to " + phase;
        return false;
    }
    if (phase == "completed") {
        completeRide(st, *r, d);
    } else {
        r->status = phase;
        if (phase == "on_trip") { d->lat = r->pickupLat; d->lng = r->pickupLng; }
    }
    return true;
}

bool cancelRide(AppState& st, const std::string& rideId, std::string* err) {
    Ride* r = st.ride(rideId);
    if (!r) { if (err) *err = "Ride not found"; return false; }
    if (r->status == "completed") { if (err) *err = "Completed rides cannot be cancelled"; return false; }
    if (r->status == "cancelled") { if (err) *err = "Ride is already cancelled"; return false; }
    if (r->status == "on_trip") { if (err) *err = "The trip already started"; return false; }
    if (!r->driverId.empty()) {
        Account* d = st.account(r->driverId);
        if (d && d->status == "busy") d->status = "online";
    }
    r->status = "cancelled";
    return true;
}

// ===========================================================================
//  OPS SIMULATION - deterministic, tick based
// ===========================================================================
std::string simulate(AppState& st, int steps, bool spawnDemand) {
    steps = std::max(1, std::min(steps, 200));
    std::mt19937 rng(static_cast<unsigned>(st.tick * 2654435761u + st.seq));
    int spawned = 0, completed = 0;

    for (int i = 0; i < steps; ++i) {
        ++st.tick;

        // 1. optional demand injection on the busiest demo corridor
        if (spawnDemand && !st.locations.empty() && (st.tick % 2 == 0)) {
            std::uniform_int_distribution<std::size_t> pick(0, st.locations.size() - 1);
            std::size_t a = pick(rng), b = pick(rng);
            if (a == b) b = (b + 1) % st.locations.size();
            const LocationCfg& from = st.locations[a];
            const LocationCfg& to = st.locations[b];
            Ride r;
            r.id = st.nextId("RIDE");
            r.code = "SBT-" + std::to_string(1000 + (st.seq % 9000));
            r.passengerId = "SIM";
            r.passengerName = "Sim Passenger " + std::to_string(spawned + 1);
            r.phone = "09170000000";
            r.pickupLabel = from.name;
            r.destLabel = to.name;
            r.pickupArea = from.zone;
            r.destArea = to.zone;
            r.pickupLat = from.lat; r.pickupLng = from.lng;
            r.destLat = to.lat;   r.destLng = to.lng;
            r.distanceKm = std::round(haversineKm(from.lat, from.lng, to.lat, to.lng) * 10.0) / 10.0;
            r.fare = computeFare(r.distanceKm, st.settings);
            r.seats = 1;
            r.queueKey = makeQueueKey(from.zone, to.zone);
            r.status = "pending";
            r.createdAt = nowMillis() + spawned;
            st.rides.push_back(r);
            ++spawned;
        }

        // 2. keep dispatch flowing while drivers are free
        if (st.settings.dispatchMode == "auto") {
            for (int guard = 0; guard < 50; ++guard) {
                if (serveNext(st).rfind("Offered", 0) != 0) break;
            }
        }

        // 3. nudge assigned drivers along their route, then advance phases
        for (auto& r : st.rides) {
            if (r.status == "offered" && nowMillis() - r.matchedAt > 15000) {
                Account* d = st.account(r.driverId);
                r.status = "pending";
                r.driverId.clear(); r.driverName.clear(); r.plate.clear(); r.vehicle.clear();
                if (d && d->status == "busy") d->status = "online";
                continue;
            }
            if (r.driverId.empty()) continue;
            Account* d = st.account(r.driverId);
            if (!d) continue;

            auto stepToward = [&](double tLat, double tLng) {
                d->lat += (tLat - d->lat) * 0.35;
                d->lng += (tLng - d->lng) * 0.35;
            };

            if (r.status == "arriving") {
                stepToward(r.pickupLat, r.pickupLng);
                if (nowMillis() - r.matchedAt > 12000) r.status = "at_pickup";
            } else if (r.status == "at_pickup") {
                r.status = "on_trip";
            } else if (r.status == "on_trip") {
                stepToward(r.destLat, r.destLng);
                r.status = "completed";
                r.completedAt = nowMillis();
                d->earnings = std::round((d->earnings + r.fare * 0.8) * 100.0) / 100.0;
                d->trips += 1;
                d->status = "online";
                ++completed;
            }
        }
    }

    std::ostringstream out;
    out << "Simulated " << steps << " tick" << (steps == 1 ? "" : "s")
        << " · " << spawned << " new request" << (spawned == 1 ? "" : "s")
        << " · " << completed << " completed";
    return out.str();
}

// ===========================================================================
//  JSON SERIALIZATION
// ===========================================================================
static std::string money(double v) {
    std::ostringstream os;
    os << std::fixed << std::setprecision(2) << v;
    return os.str();
}

Json accountJson(const Account& a, bool withDocs) {
    Json j = Json::object();
    j["id"] = a.id;
    j["role"] = a.role;
    j["name"] = a.name;
    j["email"] = a.email;
    j["phone"] = a.phone;
    j["emergency"] = a.emergency;
    j["plate"] = a.plate;
    j["vehicle"] = a.vehicle;
    j["status"] = a.status;
    j["lat"] = a.lat;
    j["lng"] = a.lng;
    j["rating"] = a.rating;
    j["earnings"] = a.earnings;
    j["trips"] = a.trips;
    j["createdAt"] = a.createdAt;
    j["hasIdImage"] = !a.idImage.empty();
    if (withDocs) {
        j["license"] = a.license;
        j["nbi"] = a.nbi;
        j["orcr"] = a.orcr;
        j["ltfrb"] = a.ltfrb;
        j["otherDocs"] = a.otherDocs;
        // The image itself is only written to the on-disk store so /api/state stays light.
    }
    return j;
}

Json rideJson(const AppState& st, const Ride& r) {
    Json j = Json::object();
    j["id"] = r.id;
    j["code"] = r.code;
    j["passengerId"] = r.passengerId;
    j["passengerName"] = r.passengerName;
    j["phone"] = r.phone;
    j["pickupLabel"] = r.pickupLabel;
    j["destLabel"] = r.destLabel;
    j["pickupArea"] = r.pickupArea;
    j["destArea"] = r.destArea;
    j["pickupLat"] = r.pickupLat; j["pickupLng"] = r.pickupLng;
    j["destLat"] = r.destLat;     j["destLng"] = r.destLng;
    j["distanceKm"] = r.distanceKm;
    j["fare"] = r.fare;
    j["fareText"] = money(r.fare);
    j["seats"] = r.seats;
    j["queueKey"] = r.queueKey;
    j["status"] = r.status;
    j["driverId"] = r.driverId;
    j["driverName"] = r.driverName;
    j["plate"] = r.plate;
    j["vehicle"] = r.vehicle;
    j["createdAt"] = r.createdAt;
    j["matchedAt"] = r.matchedAt;
    j["completedAt"] = r.completedAt;
    j["queuePosition"] = queuePosition(st, r);
    return j;
}

Json statsJson(const AppState& st) {
    int pending = 0, active = 0, completed = 0, cancelled = 0, online = 0;
    double revenue = 0.0;
    for (const auto& r : st.rides) {
        if (r.status == "pending") ++pending;
        else if (r.status == "completed") { ++completed; revenue += r.fare; }
        else if (r.status == "cancelled") ++cancelled;
        else ++active;
    }
    for (const auto& a : st.accounts) {
        if (a.role == "driver" && (a.status == "online" || a.status == "busy")) ++online;
    }
    Json j = Json::object();
    j["totalRides"] = static_cast<long long>(st.rides.size());
    j["pending"] = pending;
    j["active"] = active;
    j["completed"] = completed;
    j["cancelled"] = cancelled;
    j["onlineDrivers"] = online;
    j["drivers"] = static_cast<long long>(std::count_if(st.accounts.begin(), st.accounts.end(),
        [](const Account& a) { return a.role == "driver"; }));
    j["revenue"] = std::round(revenue * 100.0) / 100.0;
    j["avgFare"] = completed ? std::round((revenue / completed) * 100.0) / 100.0 : 0.0;
    j["completionRate"] = (completed + cancelled)
        ? std::round((100.0 * completed / (completed + cancelled)) * 10.0) / 10.0 : 0.0;
    j["queueLength"] = pending;
    j["tick"] = st.tick;
    j["generatedAt"] = isoNow();
    return j;
}

Json settingsJson(const AppState& st) {
    Json j = Json::object();
    j["serviceName"] = st.settings.serviceName;
    j["currency"] = st.settings.currency;
    j["baseFare"] = st.settings.baseFare;
    j["includedKm"] = st.settings.includedKm;
    j["perKm"] = st.settings.perKm;
    j["matchDelaySeconds"] = st.settings.matchDelaySeconds;
    j["dispatchMode"] = st.settings.dispatchMode;
    j["fareRule"] = "Fare = base + (km - includedKm) * perKm";
    return j;
}

Json uiJson(const AppState& st) {
    Json j = Json::object();
    for (const auto& kv : st.ui) j[kv.first] = kv.second;
    return j;
}

Json stateJson(const AppState& st, bool includeAccounts) {
    Json j = Json::object();
    j["settings"] = settingsJson(st);
    j["ui"] = uiJson(st);
    j["stats"] = statsJson(st);
    j["tick"] = st.tick;

    Json routes = Json::array();
    for (const auto& r : st.routes) {
        Json x = Json::object();
        x["id"] = r.id; x["name"] = r.name; x["from"] = r.from; x["to"] = r.to;
        x["baseFare"] = r.baseFare; x["perKm"] = r.perKm; x["km"] = r.km; x["active"] = r.active;
        routes.push_back(x);
    }
    j["routes"] = routes;

    Json locations = Json::array();
    for (const auto& l : st.locations) {
        Json x = Json::object();
        x["id"] = l.id; x["name"] = l.name; x["lat"] = l.lat; x["lng"] = l.lng;
        x["zone"] = l.zone; x["active"] = l.active;
        locations.push_back(x);
    }
    j["locations"] = locations;

    Json rides = Json::array();
    for (const auto& r : st.rides) rides.push_back(rideJson(st, r));
    j["rides"] = rides;

    if (includeAccounts) {
        Json drivers = Json::array();
        Json passengers = Json::array();
        for (const auto& a : st.accounts) {
            if (a.role == "driver") drivers.push_back(accountJson(a, true));
            else passengers.push_back(accountJson(a, true));
        }
        j["drivers"] = drivers;
        j["passengers"] = passengers;
    }
    return j;
}

Json stateToDisk(const AppState& st) {
    Json j = Json::object();
    j["version"] = 1;
    j["savedAt"] = isoNow();
    j["seq"] = st.seq;
    j["tick"] = st.tick;

    Json accs = Json::array();
    for (const auto& a : st.accounts) {
        Json x = accountJson(a, true);
        x["idImage"] = a.idImage; // full data URL only on disk
        accs.push_back(x);
    }
    j["accounts"] = accs;

    Json rides = Json::array();
    for (const auto& r : st.rides) {
        Json x = rideJson(st, r);
        rides.push_back(x);
    }
    j["rides"] = rides;

    Json routes = Json::array();
    for (const auto& r : st.routes) {
        Json x = Json::object();
        x["id"] = r.id; x["name"] = r.name; x["from"] = r.from; x["to"] = r.to;
        x["baseFare"] = r.baseFare; x["perKm"] = r.perKm; x["km"] = r.km; x["active"] = r.active;
        routes.push_back(x);
    }
    j["routes"] = routes;

    Json locations = Json::array();
    for (const auto& l : st.locations) {
        Json x = Json::object();
        x["id"] = l.id; x["name"] = l.name; x["lat"] = l.lat; x["lng"] = l.lng;
        x["zone"] = l.zone; x["active"] = l.active;
        locations.push_back(x);
    }
    j["locations"] = locations;

    Json ui = Json::object();
    for (const auto& kv : st.ui) ui[kv.first] = kv.second;
    j["ui"] = ui;
    j["settings"] = settingsJson(st);
    return j;
}

static Account accountFromJson(const Json& j) {
    Account a;
    a.id = j.at("id").asString();
    a.role = j.at("role").asString("passenger");
    a.name = j.at("name").asString();
    a.email = j.at("email").asString();
    a.phone = j.at("phone").asString();
    a.emergency = j.at("emergency").asString();
    a.plate = j.at("plate").asString();
    a.vehicle = j.at("vehicle").asString();
    a.license = j.at("license").asString();
    a.nbi = j.at("nbi").asString();
    a.orcr = j.at("orcr").asString();
    a.ltfrb = j.at("ltfrb").asString();
    a.otherDocs = j.at("otherDocs").asString();
    a.idImage = j.at("idImage").asString();
    a.status = j.at("status").asString("offline");
    a.lat = j.at("lat").asDouble(14.5995);
    a.lng = j.at("lng").asDouble(120.9842);
    a.rating = j.at("rating").asDouble(4.9);
    a.earnings = j.at("earnings").asDouble(0);
    a.trips = static_cast<int>(j.at("trips").asInt(0));
    a.createdAt = j.at("createdAt").asInt(0);
    return a;
}

static Ride rideFromJson(const Json& j) {
    Ride r;
    r.id = j.at("id").asString();
    r.code = j.at("code").asString();
    r.passengerId = j.at("passengerId").asString();
    r.passengerName = j.at("passengerName").asString();
    r.phone = j.at("phone").asString();
    r.pickupLabel = j.at("pickupLabel").asString();
    r.destLabel = j.at("destLabel").asString();
    r.pickupArea = j.at("pickupArea").asString();
    r.destArea = j.at("destArea").asString();
    r.pickupLat = j.at("pickupLat").asDouble();
    r.pickupLng = j.at("pickupLng").asDouble();
    r.destLat = j.at("destLat").asDouble();
    r.destLng = j.at("destLng").asDouble();
    r.distanceKm = j.at("distanceKm").asDouble();
    r.fare = j.at("fare").asDouble();
    r.seats = static_cast<int>(j.at("seats").asInt(1));
    r.queueKey = j.at("queueKey").asString();
    r.status = j.at("status").asString("pending");
    r.driverId = j.at("driverId").asString();
    r.driverName = j.at("driverName").asString();
    r.plate = j.at("plate").asString();
    r.vehicle = j.at("vehicle").asString();
    r.createdAt = j.at("createdAt").asInt(0);
    r.matchedAt = j.at("matchedAt").asInt(0);
    r.completedAt = j.at("completedAt").asInt(0);
    return r;
}

AppState stateFromDisk(const Json& j) {
    AppState st;
    st.seq = j.at("seq").asInt(5000);
    st.tick = j.at("tick").asInt(0);
    for (const auto& x : j.at("accounts").elements()) st.accounts.push_back(accountFromJson(x));
    for (const auto& x : j.at("rides").elements()) st.rides.push_back(rideFromJson(x));
    for (const auto& x : j.at("routes").elements()) {
        RouteCfg r;
        r.id = x.at("id").asString();
        r.name = x.at("name").asString();
        r.from = x.at("from").asString();
        r.to = x.at("to").asString();
        r.baseFare = x.at("baseFare").asDouble(15);
        r.perKm = x.at("perKm").asDouble(2.5);
        r.km = x.at("km").asDouble(6);
        r.active = x.at("active").asBool(true);
        st.routes.push_back(r);
    }
    for (const auto& x : j.at("locations").elements()) {
        LocationCfg l;
        l.id = x.at("id").asString();
        l.name = x.at("name").asString();
        l.lat = x.at("lat").asDouble();
        l.lng = x.at("lng").asDouble();
        l.zone = x.at("zone").asString();
        l.active = x.at("active").asBool(true);
        st.locations.push_back(l);
    }
    for (const auto& kv : j.at("ui").items()) st.ui[kv.first] = kv.second.asString();
    const Json& s = j.at("settings");
    st.settings.serviceName = s.at("serviceName").asString("Sibat Na");
    st.settings.currency = s.at("currency").asString("\xE2\x82\xB1");
    st.settings.baseFare = s.at("baseFare").asDouble(15);
    st.settings.includedKm = s.at("includedKm").asDouble(4);
    st.settings.perKm = s.at("perKm").asDouble(2.5);
    st.settings.matchDelaySeconds = static_cast<int>(s.at("matchDelaySeconds").asInt(3));
    st.settings.dispatchMode = s.at("dispatchMode").asString("auto");
    return st;
}

// ===========================================================================
//  SEED DATA - fictional Manila demo
// ===========================================================================
AppState seedState() {
    AppState st;
    st.seq = 5000;
    st.tick = 42;
    st.settings.baseFare = 15.0;
    st.settings.includedKm = 4.0;
    st.settings.perKm = 2.5;

    st.ui["brand.tagline"] = "Share the road. Split the fare.";
    st.ui["passenger.heroTitle"] = "Where are we going?";
    st.ui["passenger.searchPlaceholder"] = "Search a destination in the Philippines";
    st.ui["passenger.bookButton"] = "Book this ride";
    st.ui["driver.title"] = "Driver Mode";
    st.ui["driver.onlineLabel"] = "Go online";
    st.ui["ops.title"] = "Operations Center";

    const char* names[] = { "Mika Reyes", "Paolo Santos", "Liza Cruz", "Andres Dizon" };
    const char* plates[] = { "NCR 2841", "NCR 7715", "NCR 3306", "NCR 9022" };
    const char* vehicles[] = { "Toyota Vios", "Mitsubishi Mirage", "Suzuki Ertiga", "Toyota Innova" };
    double lat[] = { 14.5995, 14.6090, 14.5870, 14.6150 };
    double lng[] = { 120.9842, 120.9940, 120.9760, 120.9700 };

    for (int i = 0; i < 4; ++i) {
        Account a;
        a.id = "DRV-" + std::string(1, static_cast<char>('1' + i)) + "00";
        a.role = "driver";
        a.name = names[i];
        a.email = std::string("driver") + std::to_string(i + 1) + "@sibatna.demo";
        a.phone = "0917123456" + std::to_string(i);
        a.plate = plates[i];
        a.vehicle = vehicles[i];
        a.license = "N01-23-45678" + std::to_string(i);
        a.nbi = "NBI-2026-00" + std::to_string(i + 1);
        a.orcr = "OR-CR-778" + std::to_string(i + 1);
        a.ltfrb = "LTFRB-TNVS-88" + std::to_string(i + 1);
        a.status = (i == 0) ? "online" : "offline";
        a.lat = lat[i];
        a.lng = lng[i];
        a.rating = 4.7 + (i * 0.05);
        a.earnings = 1240.0 + i * 315.0;
        a.trips = 28 + i * 7;
        a.createdAt = nowMillis() - 86400000LL * (30 - i);
        st.accounts.push_back(a);
    }

    Account passenger;
    passenger.id = "PAS-7001";
    passenger.role = "passenger";
    passenger.name = "Demo Passenger";
    passenger.email = "demo@sibatna.ph";
    passenger.phone = "09171234567";
    passenger.emergency = "09181234567";
    passenger.createdAt = nowMillis() - 86400000LL * 2;
    st.accounts.push_back(passenger);

    struct Loc { const char* name; double lat; double lng; const char* zone; };
    const Loc locs[] = {
        { "SM North EDSA",          14.6564, 121.0306, "Quezon City" },
        { "Trinoma",                14.6538, 121.0330, "Quezon City" },
        { "Mall of Asia",           14.5354, 120.9822, "Pasay" },
        { "Bonifacio Global City",  14.5547, 121.0509, "Taguig" },
        { "Makati CBD",             14.5547, 121.0244, "Makati" },
        { "Intramuros",             14.5896, 120.9747, "Manila" },
        { "NAIA Terminal 3",        14.5118, 121.0194, "Pasay" },
        { "Ortigas Center",         14.5866, 121.0647, "Pasig" },
    };
    int li = 1;
    for (const auto& l : locs) {
        LocationCfg x;
        x.id = "LOC-" + std::to_string(100 + li);
        x.name = l.name;
        x.lat = l.lat;
        x.lng = l.lng;
        x.zone = l.zone;
        x.active = true;
        st.locations.push_back(x);
        ++li;
    }

    struct Rte { const char* name; const char* from; const char* to; double km; };
    const Rte rtes[] = {
        { "QC → Makati shuttle",     "Quezon City", "Makati",  11.8 },
        { "Pasay → BGC loop",        "Pasay",       "Taguig",   8.4 },
        { "Manila heritage run",     "Manila",      "Pasay",    7.2 },
    };
    int ri = 1;
    for (const auto& r : rtes) {
        RouteCfg x;
        x.id = "RTE-" + std::to_string(200 + ri);
        x.name = r.name;
        x.from = r.from;
        x.to = r.to;
        x.km = r.km;
        x.baseFare = 15.0;
        x.perKm = 2.5;
        x.active = true;
        st.routes.push_back(x);
        ++ri;
    }

    // one completed demo trip so earnings / trip log are not empty
    Ride done;
    done.id = "RIDE-4901";
    done.code = "SBT-4901";
    done.passengerId = "PAS-7001";
    done.passengerName = "Demo Passenger";
    done.phone = "09171234567";
    done.pickupLabel = "SM North EDSA";
    done.destLabel = "Makati CBD";
    done.pickupArea = "Quezon City";
    done.destArea = "Makati";
    done.pickupLat = 14.6564; done.pickupLng = 121.0306;
    done.destLat = 14.5547;   done.destLng = 121.0244;
    done.distanceKm = 11.8;
    done.fare = computeFare(done.distanceKm, st.settings);
    done.seats = 1;
    done.queueKey = makeQueueKey(done.pickupArea, done.destArea);
    done.status = "completed";
    done.driverId = "DRV-100";
    done.driverName = "Mika Reyes";
    done.plate = "NCR 2841";
    done.vehicle = "Toyota Vios";
    done.createdAt = nowMillis() - 86400000LL;
    done.matchedAt = done.createdAt + 60000;
    done.completedAt = done.createdAt + 1500000;
    st.rides.push_back(done);

    return st;
}

// ===========================================================================
//  APP - load / save
// ===========================================================================
App::App(std::string dataFile) : dataFile_(std::move(dataFile)) {}

void App::load() {
    std::ifstream in(dataFile_);
    if (!in.good()) {
        state_ = seedState();
        save();
        return;
    }
    std::ostringstream buf;
    buf << in.rdbuf();
    try {
        Json j = Json::parse(buf.str());
        state_ = stateFromDisk(j);
    } catch (const std::exception&) {
        state_ = seedState();
        save();
    }
}

void App::save() {
    std::ofstream out(dataFile_, std::ios::trunc);
    if (!out.good()) return;
    out << stateToDisk(state_).dump(2);
    out << "\n";
}

} // namespace sibat
