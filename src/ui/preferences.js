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
    ["asia_seoul", "Seoul", "Asia/Seoul"],
    ["asia_tokyo", "Tokyo", "Asia/Tokyo"],
    ["asia_singapore", "Singapore", "Asia/Singapore"],
    ["asia_shanghai", "Shanghai", "Asia/Shanghai"],
    ["asia_hong_kong", "Hong Kong", "Asia/Hong_Kong"],
    ["asia_taipei", "Taipei", "Asia/Taipei"],
    ["asia_bangkok", "Bangkok", "Asia/Bangkok"],
    ["asia_jakarta", "Jakarta", "Asia/Jakarta"],
    ["asia_kolkata", "India", "Asia/Kolkata"],
    ["asia_dubai", "Dubai", "Asia/Dubai"],
    ["asia_tehran", "Tehran", "Asia/Tehran"]
  ],
  europe: [
    ["europe_london", "London", "Europe/London"],
    ["europe_dublin", "Dublin", "Europe/Dublin"],
    ["europe_lisbon", "Lisbon", "Europe/Lisbon"],
    ["europe_paris", "Paris", "Europe/Paris"],
    ["europe_berlin", "Berlin", "Europe/Berlin"],
    ["europe_madrid", "Madrid", "Europe/Madrid"],
    ["europe_rome", "Rome", "Europe/Rome"],
    ["europe_amsterdam", "Amsterdam", "Europe/Amsterdam"],
    ["europe_stockholm", "Stockholm", "Europe/Stockholm"],
    ["europe_warsaw", "Warsaw", "Europe/Warsaw"],
    ["europe_athens", "Athens", "Europe/Athens"],
    ["europe_istanbul", "Istanbul", "Europe/Istanbul"],
    ["europe_moscow", "Moscow", "Europe/Moscow"]
  ],
  america: [
    ["america_los_angeles", "Los Angeles", "America/Los_Angeles"],
    ["america_vancouver", "Vancouver", "America/Vancouver"],
    ["america_phoenix", "Phoenix", "America/Phoenix"],
    ["america_denver", "Denver", "America/Denver"],
    ["america_chicago", "Chicago", "America/Chicago"],
    ["america_mexico_city", "Mexico City", "America/Mexico_City"],
    ["america_new_york", "New York", "America/New_York"],
    ["america_toronto", "Toronto", "America/Toronto"],
    ["america_bogota", "Bogota", "America/Bogota"],
    ["america_lima", "Lima", "America/Lima"],
    ["america_santiago", "Santiago", "America/Santiago"],
    ["america_buenos_aires", "Buenos Aires", "America/Argentina/Buenos_Aires"],
    ["america_sao_paulo", "Sao Paulo", "America/Sao_Paulo"],
    ["america_anchorage", "Anchorage", "America/Anchorage"]
  ],
  africa: [
    ["africa_casablanca", "Casablanca", "Africa/Casablanca"],
    ["africa_accra", "Accra", "Africa/Accra"],
    ["africa_lagos", "Lagos", "Africa/Lagos"],
    ["africa_tunis", "Tunis", "Africa/Tunis"],
    ["africa_cairo", "Cairo", "Africa/Cairo"],
    ["africa_johannesburg", "Johannesburg", "Africa/Johannesburg"],
    ["africa_nairobi", "Nairobi", "Africa/Nairobi"],
    ["africa_addis_ababa", "Addis Ababa", "Africa/Addis_Ababa"]
  ],
  oceania: [
    ["oceania_perth", "Perth", "Australia/Perth"],
    ["oceania_brisbane", "Brisbane", "Australia/Brisbane"],
    ["oceania_sydney", "Sydney", "Australia/Sydney"],
    ["oceania_melbourne", "Melbourne", "Australia/Melbourne"],
    ["oceania_auckland", "Auckland", "Pacific/Auckland"],
    ["oceania_fiji", "Fiji", "Pacific/Fiji"],
    ["oceania_guam", "Guam", "Pacific/Guam"],
    ["oceania_port_moresby", "Port Moresby", "Pacific/Port_Moresby"],
    ["oceania_honolulu", "Honolulu", "Pacific/Honolulu"]
  ]
};

export const TIME_ZONE_GROUPS = [
  ["asia", "🌏", "Asia"],
  ["europe", "🌍", "Europe"],
  ["america", "🌎", "America"],
  ["africa", "🌍", "Africa"],
  ["oceania", "🌊", "Oceania"],
  ["utc", "🕘", "UTC Offset"]
];

export const TIME_ZONE_CHOICES = [
  ...UTC_OFFSET_TIME_ZONE_CHOICES,
  ...Object.values(REGIONAL_TIME_ZONE_CHOICES).flat()
];

export const LOCALE_CHOICES = [
  ["en_us", "🇺🇸 en-US", "en-US"],
  ["en_gb", "🇬🇧 en-GB", "en-GB"],
  ["ko_kr", "🇰🇷 ko-KR", "ko-KR"]
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

export function formatTimeZoneChoiceLabel(label, timeZone) {
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
