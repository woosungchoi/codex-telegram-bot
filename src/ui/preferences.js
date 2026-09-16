import { textFor } from "../i18n.js";

export const UTC_OFFSET_TIME_ZONE_CHOICES = [
  ["utc_m11", "UTC-11", "Etc/GMT+11"],
  ["utc_m10", "UTC-10", "Etc/GMT+10"],
  ["utc_m09", "UTC-09", "Etc/GMT+9"],
  ["utc_m08", "UTC-08", "Etc/GMT+8"],
  ["utc_m07", "UTC-07", "Etc/GMT+7"],
  ["utc_m06", "UTC-06", "Etc/GMT+6"],
  ["utc_m05", "UTC-05", "Etc/GMT+5"],
  ["utc_m04", "UTC-04", "Etc/GMT+4"],
  ["utc_m03", "UTC-03", "Etc/GMT+3"],
  ["utc_m02", "UTC-02", "Etc/GMT+2"],
  ["utc_m01", "UTC-01", "Etc/GMT+1"],
  ["utc", "UTC+00", "UTC"],
  ["utc_p01", "UTC+01", "Etc/GMT-1"],
  ["utc_p02", "UTC+02", "Etc/GMT-2"],
  ["utc_p03", "UTC+03", "Etc/GMT-3"],
  ["utc_p04", "UTC+04", "Etc/GMT-4"],
  ["utc_p05", "UTC+05", "Etc/GMT-5"],
  ["utc_p06", "UTC+06", "Etc/GMT-6"],
  ["utc_p07", "UTC+07", "Etc/GMT-7"],
  ["utc_p08", "UTC+08", "Etc/GMT-8"],
  ["utc_p09", "UTC+09", "Etc/GMT-9"],
  ["utc_p10", "UTC+10", "Etc/GMT-10"],
  ["utc_p11", "UTC+11", "Etc/GMT-11"],
  ["utc_p12", "UTC+12", "Etc/GMT-12"]
];

export const REGIONAL_TIME_ZONE_CHOICES = {
  asia: [
    ["asia_seoul", "timeZoneCity.asia_seoul", "Asia/Seoul"],
    ["asia_tokyo", "timeZoneCity.asia_tokyo", "Asia/Tokyo"],
    ["asia_singapore", "timeZoneCity.asia_singapore", "Asia/Singapore"],
    ["asia_shanghai", "timeZoneCity.asia_shanghai", "Asia/Shanghai"],
    ["asia_hong_kong", "timeZoneCity.asia_hong_kong", "Asia/Hong_Kong"],
    ["asia_taipei", "timeZoneCity.asia_taipei", "Asia/Taipei"],
    ["asia_bangkok", "timeZoneCity.asia_bangkok", "Asia/Bangkok"],
    ["asia_jakarta", "timeZoneCity.asia_jakarta", "Asia/Jakarta"],
    ["asia_kolkata", "timeZoneCity.asia_kolkata", "Asia/Kolkata"],
    ["asia_dubai", "timeZoneCity.asia_dubai", "Asia/Dubai"],
    ["asia_tehran", "timeZoneCity.asia_tehran", "Asia/Tehran"]
  ],
  europe: [
    ["europe_london", "timeZoneCity.europe_london", "Europe/London"],
    ["europe_dublin", "timeZoneCity.europe_dublin", "Europe/Dublin"],
    ["europe_lisbon", "timeZoneCity.europe_lisbon", "Europe/Lisbon"],
    ["europe_paris", "timeZoneCity.europe_paris", "Europe/Paris"],
    ["europe_berlin", "timeZoneCity.europe_berlin", "Europe/Berlin"],
    ["europe_madrid", "timeZoneCity.europe_madrid", "Europe/Madrid"],
    ["europe_rome", "timeZoneCity.europe_rome", "Europe/Rome"],
    ["europe_amsterdam", "timeZoneCity.europe_amsterdam", "Europe/Amsterdam"],
    ["europe_stockholm", "timeZoneCity.europe_stockholm", "Europe/Stockholm"],
    ["europe_warsaw", "timeZoneCity.europe_warsaw", "Europe/Warsaw"],
    ["europe_athens", "timeZoneCity.europe_athens", "Europe/Athens"],
    ["europe_istanbul", "timeZoneCity.europe_istanbul", "Europe/Istanbul"],
    ["europe_moscow", "timeZoneCity.europe_moscow", "Europe/Moscow"]
  ],
  america: [
    ["america_los_angeles", "timeZoneCity.america_los_angeles", "America/Los_Angeles"],
    ["america_vancouver", "timeZoneCity.america_vancouver", "America/Vancouver"],
    ["america_phoenix", "timeZoneCity.america_phoenix", "America/Phoenix"],
    ["america_denver", "timeZoneCity.america_denver", "America/Denver"],
    ["america_chicago", "timeZoneCity.america_chicago", "America/Chicago"],
    ["america_mexico_city", "timeZoneCity.america_mexico_city", "America/Mexico_City"],
    ["america_new_york", "timeZoneCity.america_new_york", "America/New_York"],
    ["america_toronto", "timeZoneCity.america_toronto", "America/Toronto"],
    ["america_bogota", "timeZoneCity.america_bogota", "America/Bogota"],
    ["america_lima", "timeZoneCity.america_lima", "America/Lima"],
    ["america_santiago", "timeZoneCity.america_santiago", "America/Santiago"],
    ["america_buenos_aires", "timeZoneCity.america_buenos_aires", "America/Argentina/Buenos_Aires"],
    ["america_sao_paulo", "timeZoneCity.america_sao_paulo", "America/Sao_Paulo"],
    ["america_anchorage", "timeZoneCity.america_anchorage", "America/Anchorage"]
  ],
  africa: [
    ["africa_casablanca", "timeZoneCity.africa_casablanca", "Africa/Casablanca"],
    ["africa_accra", "timeZoneCity.africa_accra", "Africa/Accra"],
    ["africa_lagos", "timeZoneCity.africa_lagos", "Africa/Lagos"],
    ["africa_tunis", "timeZoneCity.africa_tunis", "Africa/Tunis"],
    ["africa_cairo", "timeZoneCity.africa_cairo", "Africa/Cairo"],
    ["africa_johannesburg", "timeZoneCity.africa_johannesburg", "Africa/Johannesburg"],
    ["africa_nairobi", "timeZoneCity.africa_nairobi", "Africa/Nairobi"],
    ["africa_addis_ababa", "timeZoneCity.africa_addis_ababa", "Africa/Addis_Ababa"]
  ],
  oceania: [
    ["oceania_perth", "timeZoneCity.oceania_perth", "Australia/Perth"],
    ["oceania_brisbane", "timeZoneCity.oceania_brisbane", "Australia/Brisbane"],
    ["oceania_sydney", "timeZoneCity.oceania_sydney", "Australia/Sydney"],
    ["oceania_melbourne", "timeZoneCity.oceania_melbourne", "Australia/Melbourne"],
    ["oceania_auckland", "timeZoneCity.oceania_auckland", "Pacific/Auckland"],
    ["oceania_fiji", "timeZoneCity.oceania_fiji", "Pacific/Fiji"],
    ["oceania_guam", "timeZoneCity.oceania_guam", "Pacific/Guam"],
    ["oceania_port_moresby", "timeZoneCity.oceania_port_moresby", "Pacific/Port_Moresby"],
    ["oceania_honolulu", "timeZoneCity.oceania_honolulu", "Pacific/Honolulu"]
  ]
};

export const TIME_ZONE_GROUPS = [
  ["asia", "🌏", "timeZoneGroup.asia"],
  ["europe", "🌍", "timeZoneGroup.europe"],
  ["america", "🌎", "timeZoneGroup.america"],
  ["africa", "🌍", "timeZoneGroup.africa"],
  ["oceania", "🌊", "timeZoneGroup.oceania"],
  ["utc", "🕘", "timeZoneGroup.utc"]
];

export const TIME_ZONE_CHOICES = [
  ...UTC_OFFSET_TIME_ZONE_CHOICES,
  ...Object.values(REGIONAL_TIME_ZONE_CHOICES).flat()
];

export const LOCALE_CHOICES = [
  ["en_us", "🇺🇸 en-US", "en-US"],
  ["en_gb", "🇬🇧 en-GB", "en-GB"],
  ["ko_kr", "🇰🇷 ko-KR", "ko-KR"],
  ["zh_tw", "🇹🇼 zh-TW", "zh-TW"],
  ["ru_ru", "🇷🇺 ru-RU", "ru-RU"]
];

export const TIME_PRESET_CHOICES = [
  ["00_00", "00:00"],
  ["03_30", "03:30"],
  ["09_00", "09:00"],
  ["18_00", "18:00"]
];

export function timeZoneChoicesForGroup(groupId) {
  if (groupId === "utc") return UTC_OFFSET_TIME_ZONE_CHOICES;
  return REGIONAL_TIME_ZONE_CHOICES[groupId] ?? [];
}

export function formatTimeZoneChoiceLabel(label, timeZone, text = (key) => textFor("en", key)) {
  label = text(label);
  if (/^UTC[+-]\d{2}$/.test(label) || label === "UTC+00") return label;
  return `${formatUtcOffset(timeZone)} ${label}`;
}

export function formatUtcOffset(timeZone, now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone,
      timeZoneName: "shortOffset"
    }).formatToParts(now);
    const name = parts.find((part) => part.type === "timeZoneName")?.value || "GMT";
    if (name === "GMT" || name === "UTC") return "UTC+00";
    const match = name.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
    if (!match) return name.replace(/^GMT/, "UTC");
    const [, sign, hour, minute = "00"] = match;
    return `UTC${sign}${hour.padStart(2, "0")}${minute === "00" ? "" : `:${minute}`}`;
  } catch {
    return "UTC";
  }
}
