"use strict";

/* =====================================================================
   CONFIG – API key chỉ khai báo MỘT lần tại đây.
   Muốn chuyển sang backend/proxy: đổi API_BASE và bỏ appid trong apiFetch().
   ===================================================================== */
const API_KEY = "cfb320944849b430bb81b2f27805d088";
const API_BASE = "https://api.openweathermap.org";
const ICON_URL = (code, size = "2x") => `https://openweathermap.org/img/wn/${code}@${size}.png`;

const KEYS = { theme: "weather-theme", unit: "weather-unit", recent: "weather-recent", last: "weather-last-city" };
const MAX_RECENT = 6;
const WEEKDAYS = ["Chủ nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"];

/* =====================================================================
   STATE & HELPERS
   ===================================================================== */
const state = { unit: "metric", current: null, forecast: null, uv: null, requestId: 0 };

const $ = (id) => document.getElementById(id);
const root = document.documentElement;

class WeatherError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const store = {
  get(key, fallback = null) { try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* bỏ qua */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* bỏ qua */ } },
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");

/** Chuyển timestamp UTC (giây) + timezone offset (giây) thành Date "giờ địa phương" (đọc bằng getUTC*) */
const localDate = (ts, tz) => new Date((ts + tz) * 1000);
const fmtTime = (ts, tz) => { const d = localDate(ts, tz); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };

const cToF = (c) => (c * 9) / 5 + 32;
const fmtTemp = (c) => (Number.isFinite(c) ? `${Math.round(state.unit === "imperial" ? cToF(c) : c)}°` : "--");

/** Gán nhiệt độ (°C gốc) cho element; renderTemps() sẽ cập nhật lại khi đổi đơn vị */
function setTemp(el, celsius) {
  if (!el) return;
  el.dataset.c = Number.isFinite(celsius) ? celsius : "";
  el.textContent = fmtTemp(celsius);
}
function renderTemps() {
  document.querySelectorAll("[data-c]").forEach((el) => {
    const v = parseFloat(el.dataset.c);
    el.textContent = fmtTemp(v);
  });
}

/* =====================================================================
   API LAYER
   ===================================================================== */
async function apiFetch(path, params = {}) {
  const url = new URL(API_BASE + path);
  Object.entries({ ...params, appid: API_KEY }).forEach(([k, v]) => url.searchParams.set(k, v));

  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new WeatherError("network", "Không thể kết nối mạng. Vui lòng kiểm tra Internet và thử lại.");
  }
  if (!res.ok) {
    if (res.status === 404) throw new WeatherError("not_found", "Không tìm thấy thành phố này. Hãy thử kiểm tra chính tả hoặc nhập tên khác.");
    if (res.status === 401) throw new WeatherError("auth", "API key không hợp lệ hoặc chưa được kích hoạt (key mới có thể mất vài giờ để hoạt động).");
    if (res.status === 429) throw new WeatherError("rate", "Đã vượt giới hạn số lần gọi API. Vui lòng thử lại sau ít phút.");
    throw new WeatherError("server", "Máy chủ thời tiết đang gặp sự cố. Vui lòng thử lại sau.");
  }
  try { return await res.json(); }
  catch { throw new WeatherError("server", "Dữ liệu trả về không hợp lệ."); }
}

async function getWeatherByCoordinates(lat, lon, label = null) {
  const data = await apiFetch("/data/2.5/weather", { lat, lon, units: "metric", lang: "vi" });
  data.displayName = label || data.name || "Vị trí của bạn";
  return data;
}

async function getWeatherByCity(city) {
  const q = city.trim();
  // Geocoding giúp nhận diện tốt tên tiếng Việt (Hà Nội, Hồ Chí Minh, Biên Hòa…)
  const geo = await apiFetch("/geo/1.0/direct", { q, limit: 1 });
  if (Array.isArray(geo) && geo.length) {
    const g = geo[0];
    const label = (g.local_names && g.local_names.vi) || g.name;
    return getWeatherByCoordinates(g.lat, g.lon, label);
  }
  // Fallback: tìm theo tên trực tiếp
  const data = await apiFetch("/data/2.5/weather", { q, units: "metric", lang: "vi" });
  data.displayName = data.name || q;
  return data;
}

async function getForecast(lat, lon) {
  return apiFetch("/data/2.5/forecast", { lat, lon, units: "metric", lang: "vi" });
}

/** UV không có trong Current/Forecast API miễn phí; thử endpoint UV, thất bại thì trả null (UI hiển thị "—") */
async function getUV(lat, lon) {
  try {
    const d = await apiFetch("/data/2.5/uvi", { lat, lon });
    return typeof d.value === "number" ? d.value : null;
  } catch { return null; }
}

/* =====================================================================
   ORCHESTRATION
   ===================================================================== */
async function loadWeather(fetchCurrent) {
  const id = ++state.requestId;
  showLoading();
  try {
    const data = await fetchCurrent();
    const { lat, lon } = data.coord;
    const [forecast, uv] = await Promise.all([getForecast(lat, lon), getUV(lat, lon)]);
    if (id !== state.requestId) return; // đã có request mới hơn

    state.current = data; state.forecast = forecast; state.uv = uv;
    applyWeatherTheme(data);
    updateCurrentWeather(data);
    updateForecast(forecast);
    updateUV(uv);
    renderTemps();

    saveRecent(data.displayName);
    store.set(KEYS.last, data.displayName);
    hideLoading();
  } catch (err) {
    if (id !== state.requestId) return;
    hideLoading();
    handleError(err);
  }
}

function searchCity(city) {
  const q = (city || "").trim();
  if (!q) { showError("Hãy nhập tên thành phố để tìm kiếm.", "warning"); return; }
  $("searchInput").value = q;
  loadWeather(() => getWeatherByCity(q));
}

function handleError(err) {
  const msg = err instanceof WeatherError ? err.message : "Đã xảy ra lỗi không mong muốn. Vui lòng thử lại.";
  if (!(err instanceof WeatherError)) console.error(err);
  showError(msg);
  if (!state.current) showEmpty(); // chưa có dữ liệu nào → hiện empty state
}

/* =====================================================================
   UI STATE: loading / error / empty
   ===================================================================== */
function showLoading() {
  $("alertBox").innerHTML = "";
  $("emptyState").hidden = true;
  $("content").hidden = false;
  $("content").classList.add("is-loading");
  if (!$("hourlyList").children.length) renderPlaceholders();
  $("searchBtn").disabled = true;
}
function hideLoading() {
  $("content").classList.remove("is-loading");
  $("searchBtn").disabled = false;
  if (!state.current) $("content").hidden = true;
}
function showEmpty() { $("content").hidden = true; $("emptyState").hidden = false; }

function showError(message, type = "danger") {
  const box = $("alertBox");
  box.innerHTML = "";
  const el = document.createElement("div");
  el.className = `m3-alert ${type === "warning" ? "warning" : ""}`;
  el.setAttribute("role", "alert");
  el.innerHTML = `<i class="bi ${type === "warning" ? "bi-info-circle-fill" : "bi-exclamation-triangle-fill"}"></i>
                  <span class="msg">${esc(message)}</span>
                  <button type="button" aria-label="Đóng"><i class="bi bi-x-lg"></i></button>`;
  el.querySelector("button").addEventListener("click", () => el.remove());
  box.appendChild(el);
}

function renderPlaceholders() {
  $("hourlyList").innerHTML = Array.from({ length: 8 }, () => '<div class="hour-card placeholder"></div>').join("");
  $("dailyList").innerHTML = Array.from({ length: 5 }, () => '<div class="col"><div class="day-card placeholder"></div></div>').join("");
}

/* =====================================================================
   RENDERING
   ===================================================================== */
const text = (id, value) => { $(id).textContent = value; };

function windDirection(deg) {
  const dirs = ["Bắc", "Đông Bắc", "Đông", "Đông Nam", "Nam", "Tây Nam", "Tây", "Tây Bắc"];
  return dirs[Math.round(deg / 45) % 8];
}

function updateCurrentWeather(data) {
  const tz = data.timezone || 0;
  const w = data.weather[0];
  const m = data.main;
  const windKmh = (data.wind?.speed ?? 0) * 3.6;
  const visKm = (data.visibility ?? 0) / 1000;
  const country = data.sys?.country ? `, ${data.sys.country}` : "";

  text("cityName", `${data.displayName}${country}`);
  const now = localDate(Math.floor(Date.now() / 1000), tz);
  text("localTime", `${WEEKDAYS[now.getUTCDay()]}, ${now.getUTCDate()}/${now.getUTCMonth() + 1} · ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`);
  text("weatherDesc", w.description);

  const icon = $("weatherIcon");
  icon.src = ICON_URL(w.icon, "4x");
  icon.alt = w.description;

  setTemp($("heroTemp"), m.temp);
  setTemp($("heroFeels"), m.feels_like);
  setTemp($("heroMin"), m.temp_min);
  setTemp($("heroMax"), m.temp_max);

  text("heroHumidity", `${m.humidity}%`);
  text("heroWind", `${windKmh.toFixed(1)} km/h`);
  text("heroPressure", `${m.pressure} hPa`);
  text("heroVisibility", `${visKm.toFixed(1)} km`);
  text("heroSunrise", fmtTime(data.sys.sunrise, tz));
  text("heroSunset", fmtTime(data.sys.sunset, tz));

  // Info cards
  text("dHumidity", `${m.humidity}%`);
  $("dHumidityBar").style.width = `${m.humidity}%`;
  text("dHumidityNote", m.humidity < 30 ? "Khô" : m.humidity <= 60 ? "Thoải mái" : m.humidity <= 80 ? "Hơi ẩm" : "Rất ẩm");

  text("dWind", `${windKmh.toFixed(1)} km/h`);
  $("dWindArrow").style.transform = `rotate(${(data.wind?.deg ?? 0) + 180}deg)`;
  text("dWindNote", `Hướng ${windDirection(data.wind?.deg ?? 0)}${data.wind?.gust ? ` · giật ${(data.wind.gust * 3.6).toFixed(0)} km/h` : ""}`);

  text("dPressure", `${m.pressure} hPa`);
  text("dPressureNote", m.pressure < 1000 ? "Thấp" : m.pressure <= 1020 ? "Bình thường" : "Cao");

  text("dVisibility", `${visKm.toFixed(1)} km`);
  text("dVisibilityNote", visKm >= 10 ? "Rất tốt" : visKm >= 5 ? "Tốt" : visKm >= 2 ? "Trung bình" : "Hạn chế");

  const clouds = data.clouds?.all ?? 0;
  text("dClouds", `${clouds}%`);
  $("dCloudsBar").style.width = `${clouds}%`;
  text("dCloudsNote", clouds < 20 ? "Trời quang" : clouds < 60 ? "Ít mây" : clouds < 85 ? "Nhiều mây" : "U ám");

  setTemp($("dFeels"), m.feels_like);
  const diff = m.feels_like - m.temp;
  text("dFeelsNote", Math.abs(diff) < 1 ? "Gần bằng nhiệt độ thực" : diff > 0 ? "Nóng hơn nhiệt độ thực" : "Lạnh hơn nhiệt độ thực");

  text("dSun", `${fmtTime(data.sys.sunrise, tz)} – ${fmtTime(data.sys.sunset, tz)}`);
  const daySec = data.sys.sunset - data.sys.sunrise;
  text("dSunNote", `Ngày dài ${Math.floor(daySec / 3600)}g ${Math.round((daySec % 3600) / 60)}p`);
}

function updateUV(uv) {
  if (uv === null) {
    text("dUv", "—");
    text("dUvNote", "Không có dữ liệu UV");
    return;
  }
  text("dUv", uv.toFixed(1));
  text("dUvNote", uv < 3 ? "Thấp" : uv < 6 ? "Trung bình" : uv < 8 ? "Cao" : uv < 11 ? "Rất cao" : "Cực cao");
}

/** Gom dữ liệu forecast (3 giờ/lần) theo ngày địa phương */
function groupByDay(list, tz) {
  const days = new Map();
  list.forEach((item) => {
    const d = localDate(item.dt, tz);
    const key = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    if (!days.has(key)) days.set(key, { key, date: d, items: [] });
    days.get(key).items.push({ ...item, hour: d.getUTCHours() });
  });
  return [...days.values()];
}

function updateForecast(forecast) {
  const tz = forecast.city?.timezone ?? state.current?.timezone ?? 0;
  const list = forecast.list || [];

  // ---- Theo giờ (12 mốc ≈ 36 giờ)
  let lastDay = null;
  $("hourlyList").innerHTML = list.slice(0, 12).map((it, i) => {
    const d = localDate(it.dt, tz);
    const day = d.getUTCDate();
    const label = lastDay !== null && day !== lastDay ? `${WEEKDAYS[d.getUTCDay()].replace("Chủ nhật", "CN")} ${pad(d.getUTCHours())}h` : `${pad(d.getUTCHours())}:00`;
    lastDay = day;
    const w = it.weather[0];
    return `<div class="hour-card" style="animation-delay:${i * 30}ms">
      <span class="time">${label}</span>
      <img src="${ICON_URL(w.icon)}" alt="${esc(w.description)}" width="52" height="52" loading="lazy">
      <span class="temp" data-c="${it.main.temp}">${fmtTemp(it.main.temp)}</span>
      <span class="desc">${esc(w.description)}</span>
    </div>`;
  }).join("");

  // ---- 5 ngày tiếp theo
  const nowLocal = localDate(Math.floor(Date.now() / 1000), tz);
  const todayKey = `${nowLocal.getUTCFullYear()}-${pad(nowLocal.getUTCMonth() + 1)}-${pad(nowLocal.getUTCDate())}`;
  const groups = groupByDay(list, tz);
  const future = groups.filter((g) => g.key !== todayKey).slice(0, 5);

  $("dailyList").innerHTML = future.map((g, i) => {
    const hi = Math.max(...g.items.map((x) => x.main.temp_max));
    const lo = Math.min(...g.items.map((x) => x.main.temp_min));
    const rep = g.items.reduce((a, b) => (Math.abs(b.hour - 12) < Math.abs(a.hour - 12) ? b : a));
    const w = rep.weather[0];
    return `<div class="col"><article class="day-card" style="animation-delay:${i * 50}ms">
      <div class="name">${i === 0 && g.date.getUTCDate() === new Date(Date.now() + (tz + 86400) * 1000).getUTCDate() ? "Ngày mai" : WEEKDAYS[g.date.getUTCDay()]}</div>
      <div class="date">${g.date.getUTCDate()}/${g.date.getUTCMonth() + 1}</div>
      <img src="${ICON_URL(w.icon, "4x")}" alt="${esc(w.description)}" width="64" height="64" loading="lazy">
      <div class="range"><b data-c="${hi}">${fmtTemp(hi)}</b> <span class="lo" data-c="${lo}">${fmtTemp(lo)}</span></div>
      <div class="desc">${esc(w.description)}</div>
    </article></div>`;
  }).join("");

  // ---- Cao/thấp của hôm nay (chính xác hơn từ forecast)
  const today = groups.find((g) => g.key === todayKey);
  if (today && state.current) {
    const t = state.current.main.temp;
    setTemp($("heroMax"), Math.max(t, ...today.items.map((x) => x.main.temp_max)));
    setTemp($("heroMin"), Math.min(t, ...today.items.map((x) => x.main.temp_min)));
  }
}

/** Đổi theme theo điều kiện thời tiết */
function applyWeatherTheme(data) {
  const main = (data.weather[0].main || "").toLowerCase();
  let key = "clear";
  if (main === "clouds") key = "clouds";
  else if (main === "rain" || main === "drizzle") key = "rain";
  else if (main === "thunderstorm") key = "thunderstorm";
  else if (main === "snow") key = "snow";
  else if (main !== "clear") key = "mist"; // Mist, Fog, Haze, Smoke, Dust, Sand, Ash, Squall, Tornado
  document.body.dataset.weather = key;
  document.body.dataset.time = data.weather[0].icon.endsWith("n") ? "night" : "day";
}

/* =====================================================================
   TEMPERATURE UNIT
   ===================================================================== */
function setUnit(unit) {
  state.unit = unit === "imperial" ? "imperial" : "metric";
  store.set(KEYS.unit, state.unit);
  document.querySelectorAll(".unit-toggle button").forEach((b) => b.classList.toggle("active", b.dataset.unit === state.unit));
  renderTemps(); // không cần gọi lại API
}

/* =====================================================================
   THEME (light / dark)
   ===================================================================== */
function applyTheme(theme) {
  root.dataset.theme = theme;
  root.setAttribute("data-bs-theme", theme);
  const icon = $("themeBtn")?.querySelector("i");
  if (icon) icon.className = `bi ${theme === "dark" ? "bi-sun-fill" : "bi-moon-stars-fill"}`;
}
function toggleTheme() {
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  store.set(KEYS.theme, next);
}

/* =====================================================================
   RECENT SEARCHES
   ===================================================================== */
function getRecent() {
  try { const a = JSON.parse(store.get(KEYS.recent, "[]")); return Array.isArray(a) ? a : []; } catch { return []; }
}
function saveRecent(name) {
  if (!name) return;
  const list = [name, ...getRecent().filter((c) => c.toLowerCase() !== name.toLowerCase())].slice(0, MAX_RECENT);
  store.set(KEYS.recent, JSON.stringify(list));
  renderRecent();
}
function renderRecent() {
  const list = getRecent();
  const box = $("recentList");
  box.innerHTML = "";
  $("recentSection").hidden = list.length === 0;
  list.forEach((city) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.dataset.city = city;
    b.textContent = city;
    box.appendChild(b);
  });
}

/* =====================================================================
   GEOLOCATION
   ===================================================================== */
function useMyLocation() {
  if (!("geolocation" in navigator)) {
    showError("Trình duyệt của bạn không hỗ trợ định vị. Hãy tìm thành phố thủ công nhé.", "warning");
    return;
  }
  const btn = $("locationBtn");
  const icon = btn.querySelector("i");
  btn.disabled = true;
  icon.className = "bi bi-arrow-repeat spin";

  const reset = () => { btn.disabled = false; icon.className = "bi bi-geo-alt-fill"; };

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      reset();
      loadWeather(() => getWeatherByCoordinates(pos.coords.latitude, pos.coords.longitude));
    },
    (err) => {
      reset();
      const msgs = {
        1: "Bạn đã từ chối quyền truy cập vị trí. Không sao, hãy tìm kiếm thành phố thủ công nhé!",
        2: "Không xác định được vị trí hiện tại. Hãy thử tìm kiếm thành phố thủ công.",
        3: "Hết thời gian chờ xác định vị trí. Vui lòng thử lại hoặc tìm thành phố thủ công.",
      };
      showError(msgs[err.code] || "Không thể lấy vị trí của bạn.", "warning");
      if (!state.current) showEmpty();
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
  );
}

/* =====================================================================
   INIT
   ===================================================================== */
function init() {
  // Theme
  const savedTheme = store.get(KEYS.theme);
  applyTheme(savedTheme || (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"));

  // Unit
  setUnit(store.get(KEYS.unit, "metric"));

  // Events
  $("searchForm").addEventListener("submit", (e) => { e.preventDefault(); searchCity($("searchInput").value); });
  $("locationBtn").addEventListener("click", useMyLocation);
  $("themeBtn").addEventListener("click", toggleTheme);
  document.querySelectorAll(".unit-toggle button").forEach((b) => b.addEventListener("click", () => setUnit(b.dataset.unit)));
  $("clearRecentBtn").addEventListener("click", () => { store.remove(KEYS.recent); renderRecent(); });

  // Click vào chip (recent / gợi ý) → tìm lại
  document.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-city]");
    if (chip) searchCity(chip.dataset.city);
  });

  renderRecent();

  // Tải thành phố gần nhất, nếu chưa có thì hiện empty state
  const last = store.get(KEYS.last);
  if (last) searchCity(last);
  else showEmpty();
}

document.addEventListener("DOMContentLoaded", init);