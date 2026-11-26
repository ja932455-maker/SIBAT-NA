// ============================================================================
//  SIBAT NA - backend/include/core.hpp
//  DOMAIN CORE: accounts, ride queue, driver matching, fare, simulation.
//  This is the authoritative engine. The browser is only a view.
// ============================================================================
#pragma once

#include "json.hpp"
#include <string>
#include <vector>
#include <map>
#include <mutex>

namespace sibat {

// ---------------------------------------------------------------------------
//  MONEY / TIME HELPERS
// ---------------------------------------------------------------------------
long long nowMillis();
std::string isoNow();

// ---------------------------------------------------------------------------
//  MODEL - everything the system persists lives here
// ---------------------------------------------------------------------------
struct Account {
    std::string id;
    std::string role = "passenger";      // "passenger" | "driver"
    std::string name;
    std::string email;
    std::string phone;
    std::string emergency;
    std::string plate;
    std::string vehicle;
    std::string license;                 // driver documents (demo strings)
    std::string nbi;
    std::string orcr;
    std::string ltfrb;
    std::string otherDocs;
    std::string idImage;                 // data URL or "skipped"
    std::string status = "offline";      // offline | online | busy
    double lat = 14.5995, lng = 120.9842;
    double rating = 4.9;
    double earnings = 0.0;
    int trips = 0;
    long long createdAt = 0;
};

struct Ride {
    std::string id;
    std::string code;
    std::string passengerId;
    std::string passengerName;
    std::string phone;
    std::string pickupLabel;
    std::string destLabel;
    std::string pickupArea;              // zone used for the shared queue
    std::string destArea;
    double pickupLat = 0, pickupLng = 0;
    double destLat = 0, destLng = 0;
    double distanceKm = 0;
    double fare = 0;
    int seats = 1;
    std::string queueKey;
    std::string status = "pending";      // pending|offered|arriving|at_pickup|on_trip|completed|cancelled
    std::string driverId;
    std::string driverName;
    std::string plate;
    std::string vehicle;
    long long createdAt = 0;
    long long matchedAt = 0;
    long long completedAt = 0;
};

struct RouteCfg {
    std::string id;
    std::string name;
    std::string from;
    std::string to;
    double baseFare = 15.0;
    double perKm = 2.5;
    double km = 6.0;
    bool active = true;
};

struct LocationCfg {
    std::string id;
    std::string name;
    double lat = 0, lng = 0;
    std::string zone;
    bool active = true;
};

struct Settings {
    std::string serviceName = "Sibat Na";
    std::string currency = "\xE2\x82\xB1"; // ₱
    double baseFare = 15.0;
    double includedKm = 4.0;
    double perKm = 2.5;
    int matchDelaySeconds = 3;
    std::string dispatchMode = "auto";
};

struct AppState {
    std::vector<Account> accounts;
    std::vector<Ride> rides;
    std::vector<RouteCfg> routes;
    std::vector<LocationCfg> locations;
    std::map<std::string, std::string> ui;      // editable labels for the ops center
    Settings settings;
    long long seq = 5000;
    long long tick = 0;

    std::string nextId(const std::string& prefix);
    Account* account(const std::string& id);
    Ride* ride(const std::string& id);
    RouteCfg* route(const std::string& id);
    LocationCfg* location(const std::string& id);
};

// ---------------------------------------------------------------------------
//  GEOMETRY + FARE RULES
// ---------------------------------------------------------------------------
double haversineKm(double lat1, double lng1, double lat2, double lng2);
double computeFare(double km, const Settings& s);
std::string makeQueueKey(const std::string& pickupArea, const std::string& destArea);

// ---------------------------------------------------------------------------
//  QUEUE + DISPATCH
// ---------------------------------------------------------------------------
// 1-based position in the shared FIFO queue (0 when matched/cancelled).
int queuePosition(const AppState& st, const Ride& r);
bool earlierRide(const Ride& a, const Ride& b);
Ride* oldestPending(AppState& st, const std::string& queueKey = "");
Account* bestDriverFor(AppState& st, const Ride& r);
// Offer a pending ride to a free driver (status becomes "offered").
Ride* offerRide(AppState& st, Ride& r, std::string* reason = nullptr);
// Ops "serve next": assign the oldest pending ride to the nearest free driver.
std::string serveNext(AppState& st);
// Demo autopilot: advance ONE specific ride one phase (used by the passenger UI
// so the demo progresses even when nobody is driving). Returns the ride.
Ride* demoAdvance(AppState& st, const std::string& rideId, std::string* message = nullptr);
// Demo-only: create a walk-in passenger near a driver for random driver matches.
Ride* spawnWalkInPassenger(AppState& st, Account& driver);
// Driver accepts an offered ride -> arriving.
bool acceptRide(AppState& st, const std::string& driverId, const std::string& rideId, std::string* err);
// Driver rejects an offer -> back to pending, driver stays online.
bool rejectRide(AppState& st, const std::string& driverId, const std::string& rideId, std::string* err);
// Advance one phase: arriving -> at_pickup -> on_trip -> completed.
bool advancePhase(AppState& st, const std::string& driverId, const std::string& rideId, const std::string& phase, std::string* err);
bool cancelRide(AppState& st, const std::string& rideId, std::string* err);

// ---------------------------------------------------------------------------
//  OPS SIMULATION
// ---------------------------------------------------------------------------
std::string simulate(AppState& st, int steps, bool spawnDemand);

// ---------------------------------------------------------------------------
//  SERIALIZATION (file store + API payloads)
// ---------------------------------------------------------------------------
Json accountJson(const Account& a, bool withDocs);
Json rideJson(const AppState& st, const Ride& r);
Json statsJson(const AppState& st);
Json stateJson(const AppState& st, bool includeAccounts);
Json settingsJson(const AppState& st);
Json uiJson(const AppState& st);

Json stateToDisk(const AppState& st);
AppState stateFromDisk(const Json& j);

// ---------------------------------------------------------------------------
//  SEED - demo data so the project is never empty on first run
// ---------------------------------------------------------------------------
AppState seedState();

// ---------------------------------------------------------------------------
//  APP - state + persistence + mutex, shared by every HTTP handler
// ---------------------------------------------------------------------------
class App {
public:
    App(std::string dataFile);
    void load();
    void save();
    AppState& state() { return state_; }
    std::mutex& mutex() { return mutex_; }
    const std::string& dataFile() const { return dataFile_; }
private:
    AppState state_;
    std::string dataFile_;
    std::mutex mutex_;
};

} // namespace sibat
