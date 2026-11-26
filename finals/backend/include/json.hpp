// ============================================================================
//  SIBAT NA - backend/include/json.hpp
//  A tiny dependency-free JSON parser/serializer used by the C++ API.
//  Supports: null, bool, number, string (incl. \uXXXX), array, object.
//  Kept small on purpose - the whole project builds with nothing but g++.
// ============================================================================
#pragma once

#include <string>
#include <vector>
#include <map>
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <algorithm>

namespace sibat {

class Json {
public:
    enum class Type { Null, Bool, Number, String, Array, Object };

    Json() : type_(Type::Null) {}
    Json(std::nullptr_t) : type_(Type::Null) {}
    Json(bool b) : type_(Type::Bool), bool_(b) {}
    Json(double n) : type_(Type::Number), num_(n) {}
    Json(int n) : type_(Type::Number), num_(static_cast<double>(n)) {}
    Json(long long n) : type_(Type::Number), num_(static_cast<double>(n)) {}
    Json(const char* s) : type_(Type::String), str_(s ? s : "") {}
    Json(std::string s) : type_(Type::String), str_(std::move(s)) {}

    static Json object() { Json j; j.type_ = Type::Object; return j; }
    static Json array()  { Json j; j.type_ = Type::Array;  return j; }
    static Json null()   { return Json(); }

    Type type() const { return type_; }
    bool isNull()   const { return type_ == Type::Null; }
    bool isBool()   const { return type_ == Type::Bool; }
    bool isNumber() const { return type_ == Type::Number; }
    bool isString() const { return type_ == Type::String; }
    bool isArray()  const { return type_ == Type::Array; }
    bool isObject() const { return type_ == Type::Object; }

    // ---- object helpers -----------------------------------------------------
    bool has(const std::string& key) const {
        return type_ == Type::Object && obj_.find(key) != obj_.end();
    }
    Json& operator[](const std::string& key) {
        if (type_ != Type::Object) { type_ = Type::Object; obj_.clear(); }
        return obj_[key];
    }
    const Json& at(const std::string& key) const {
        static const Json empty;
        if (type_ != Type::Object) return empty;
        auto it = obj_.find(key);
        return it == obj_.end() ? empty : it->second;
    }
    const std::map<std::string, Json>& items() const { return obj_; }

    // ---- array helpers ------------------------------------------------------
    void push_back(const Json& v) {
        if (type_ != Type::Array) { type_ = Type::Array; arr_.clear(); }
        arr_.push_back(v);
    }
    const std::vector<Json>& elements() const { return arr_; }
    std::size_t size() const {
        if (type_ == Type::Array) return arr_.size();
        if (type_ == Type::Object) return obj_.size();
        return 0;
    }

    // ---- scalar readers (safe defaults) -------------------------------------
    std::string asString(const std::string& fallback = "") const {
        if (type_ == Type::String) return str_;
        if (type_ == Type::Number) return numberToString(num_);
        if (type_ == Type::Bool) return bool_ ? "true" : "false";
        return fallback;
    }
    double asDouble(double fallback = 0.0) const {
        if (type_ == Type::Number) return num_;
        if (type_ == Type::String) { try { return std::stod(str_); } catch (...) { return fallback; } }
        if (type_ == Type::Bool) return bool_ ? 1.0 : 0.0;
        return fallback;
    }
    long long asInt(long long fallback = 0) const {
        if (type_ == Type::Number) return static_cast<long long>(std::llround(num_));
        if (type_ == Type::String) { try { return std::stoll(str_); } catch (...) { return fallback; } }
        return fallback;
    }
    bool asBool(bool fallback = false) const {
        if (type_ == Type::Bool) return bool_;
        if (type_ == Type::Number) return num_ != 0.0;
        if (type_ == Type::String) return str_ == "true" || str_ == "1";
        return fallback;
    }

    // ---- serialization ------------------------------------------------------
    std::string dump(int indent = -1) const {
        std::string out;
        write(out, indent, 0);
        return out;
    }

    static Json parse(const std::string& text) {
        Parser p(text);
        Json v = p.parseValue();
        p.skipWs();
        return v;
    }

private:
    Type type_ = Type::Null;
    bool bool_ = false;
    double num_ = 0.0;
    std::string str_;
    std::vector<Json> arr_;
    std::map<std::string, Json> obj_;

    static std::string numberToString(double n) {
        if (!std::isfinite(n)) return "0";
        if (n == static_cast<long long>(n) && std::fabs(n) < 1e15) {
            return std::to_string(static_cast<long long>(n));
        }
        char buf[64];
        std::snprintf(buf, sizeof(buf), "%.10g", n);
        return std::string(buf);
    }

    void write(std::string& out, int indent, int depth) const {
        switch (type_) {
        case Type::Null: out += "null"; break;
        case Type::Bool: out += bool_ ? "true" : "false"; break;
        case Type::Number: out += numberToString(num_); break;
        case Type::String: writeString(out, str_); break;
        case Type::Array: {
            out += '[';
            for (std::size_t i = 0; i < arr_.size(); ++i) {
                if (i) out += ',';
                if (indent >= 0) { out += '\n'; out.append((depth + 1) * indent, ' '); }
                arr_[i].write(out, indent, depth + 1);
            }
            if (indent >= 0 && !arr_.empty()) { out += '\n'; out.append(depth * indent, ' '); }
            out += ']';
            break;
        }
        case Type::Object: {
            out += '{';
            std::size_t i = 0;
            for (const auto& kv : obj_) {
                if (i++) out += ',';
                if (indent >= 0) { out += '\n'; out.append((depth + 1) * indent, ' '); }
                writeString(out, kv.first);
                out += ':';
                if (indent >= 0) out += ' ';
                kv.second.write(out, indent, depth + 1);
            }
            if (indent >= 0 && !obj_.empty()) { out += '\n'; out.append(depth * indent, ' '); }
            out += '}';
            break;
        }
        }
    }

    static void writeString(std::string& out, const std::string& s) {
        out += '"';
        for (unsigned char c : s) {
            switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += static_cast<char>(c); // UTF-8 passes through untouched
                }
            }
        }
        out += '"';
    }

    // ---- recursive-descent parser ------------------------------------------
    struct Parser {
        const std::string& src;
        std::size_t pos = 0;
        explicit Parser(const std::string& s) : src(s) {}

        [[noreturn]] void fail(const std::string& what) {
            throw std::runtime_error("JSON parse error at byte " + std::to_string(pos) + ": " + what);
        }
        bool eof() const { return pos >= src.size(); }
        char peek() const { return eof() ? '\0' : src[pos]; }
        char take() { return eof() ? '\0' : src[pos++]; }
        void skipWs() {
            while (!eof() && (src[pos] == ' ' || src[pos] == '\t' || src[pos] == '\n' || src[pos] == '\r')) ++pos;
        }
        void expect(char c) {
            skipWs();
            if (peek() != c) fail(std::string("expected '") + c + "'");
            ++pos;
        }

        Json parseValue() {
            skipWs();
            if (eof()) fail("unexpected end of input");
            char c = peek();
            if (c == '{') return parseObject();
            if (c == '[') return parseArray();
            if (c == '"') return Json(parseString());
            if (c == 't') { expectWord("true");  return Json(true); }
            if (c == 'f') { expectWord("false"); return Json(false); }
            if (c == 'n') { expectWord("null");  return Json(); }
            return parseNumber();
        }

        void expectWord(const char* w) {
            std::size_t n = std::char_traits<char>::length(w);
            if (src.compare(pos, n, w) != 0) fail(std::string("expected ") + w);
            pos += n;
        }

        Json parseObject() {
            Json obj = Json::object();
            expect('{');
            skipWs();
            if (peek() == '}') { ++pos; return obj; }
            while (true) {
                skipWs();
                if (peek() != '"') fail("expected object key string");
                std::string key = parseString();
                expect(':');
                obj[key] = parseValue();
                skipWs();
                char c = take();
                if (c == '}') break;
                if (c != ',') fail("expected ',' or '}' in object");
            }
            return obj;
        }

        Json parseArray() {
            Json arr = Json::array();
            expect('[');
            skipWs();
            if (peek() == ']') { ++pos; return arr; }
            while (true) {
                arr.push_back(parseValue());
                skipWs();
                char c = take();
                if (c == ']') break;
                if (c != ',') fail("expected ',' or ']' in array");
            }
            return arr;
        }

        Json parseNumber() {
            skipWs();
            std::size_t start = pos;
            if (peek() == '-') ++pos;
            while (!eof() && std::isdigit(static_cast<unsigned char>(src[pos]))) ++pos;
            if (peek() == '.') { ++pos; while (!eof() && std::isdigit(static_cast<unsigned char>(src[pos]))) ++pos; }
            if (peek() == 'e' || peek() == 'E') {
                ++pos;
                if (peek() == '+' || peek() == '-') ++pos;
                while (!eof() && std::isdigit(static_cast<unsigned char>(src[pos]))) ++pos;
            }
            if (pos == start) fail("invalid value");
            try { return Json(std::stod(src.substr(start, pos - start))); }
            catch (...) { fail("invalid number"); }
        }

        std::string parseString() {
            expect('"');
            std::string out;
            while (true) {
                if (eof()) fail("unterminated string");
                char c = take();
                if (c == '"') break;
                if (c == '\\') {
                    if (eof()) fail("unterminated escape");
                    char e = take();
                    switch (e) {
                    case '"': out += '"'; break;
                    case '\\': out += '\\'; break;
                    case '/': out += '/'; break;
                    case 'b': out += '\b'; break;
                    case 'f': out += '\f'; break;
                    case 'n': out += '\n'; break;
                    case 'r': out += '\r'; break;
                    case 't': out += '\t'; break;
                    case 'u': appendUtf8(out, parseHex4()); break;
                    default: fail("bad escape");
                    }
                } else {
                    out += c;
                }
            }
            return out;
        }

        unsigned parseHex4() {
            unsigned v = 0;
            for (int i = 0; i < 4; ++i) {
                if (eof()) fail("truncated \\u escape");
                char c = take();
                v <<= 4;
                if (c >= '0' && c <= '9') v |= static_cast<unsigned>(c - '0');
                else if (c >= 'a' && c <= 'f') v |= static_cast<unsigned>(c - 'a' + 10);
                else if (c >= 'A' && c <= 'F') v |= static_cast<unsigned>(c - 'A' + 10);
                else fail("bad hex digit in \\u escape");
            }
            return v;
        }

        void appendUtf8(std::string& out, unsigned cp) {
            if (cp >= 0xD800 && cp <= 0xDBFF) {
                // high surrogate: combine with the following low surrogate if present
                if (pos + 5 < src.size() + 1 && src.compare(pos, 2, "\\u") == 0) {
                    std::size_t save = pos;
                    pos += 2;
                    unsigned low = parseHex4();
                    if (low >= 0xDC00 && low <= 0xDFFF) {
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
                    } else {
                        pos = save;
                    }
                }
            }
            if (cp < 0x80) {
                out += static_cast<char>(cp);
            } else if (cp < 0x800) {
                out += static_cast<char>(0xC0 | (cp >> 6));
                out += static_cast<char>(0x80 | (cp & 0x3F));
            } else if (cp < 0x10000) {
                out += static_cast<char>(0xE0 | (cp >> 12));
                out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
                out += static_cast<char>(0x80 | (cp & 0x3F));
            } else {
                out += static_cast<char>(0xF0 | (cp >> 18));
                out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
                out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
                out += static_cast<char>(0x80 | (cp & 0x3F));
            }
        }
    };
};

} // namespace sibat
