// Team → flag resolution for World Cup nations, offline and deterministic.
// We render real SVG flags (flag-icons) keyed by ISO 3166-1 alpha-2 codes, NOT
// Unicode flag emoji — those render as bare country-code letters ("PT", "MX") on
// Windows and many browsers. `isoForName` maps a team name to its flag code.
//
// We ALSO keep a static ParticipantId → team registry: the live team list comes
// from the current forward-fixture snapshot, so a team whose matches have already
// dropped off it can't be resolved by name lookup alone. This registry makes an
// id always resolve to a real name + flag (never a raw "Team 1634").

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

// canonical name → ISO alpha-2 (or GB subdivision) flag code
const ISO: Record<string, string> = {
  argentina: "ar", australia: "au", austria: "at", belgium: "be", bolivia: "bo",
  brazil: "br", cameroon: "cm", canada: "ca", chile: "cl", colombia: "co",
  "costa rica": "cr", croatia: "hr", czechia: "cz", denmark: "dk", ecuador: "ec",
  egypt: "eg", england: "gb-eng", france: "fr", germany: "de", ghana: "gh",
  greece: "gr", honduras: "hn", hungary: "hu", iran: "ir", ireland: "ie",
  italy: "it", "ivory coast": "ci", jamaica: "jm", japan: "jp", mexico: "mx",
  morocco: "ma", netherlands: "nl", "new zealand": "nz", nigeria: "ng", norway: "no",
  panama: "pa", paraguay: "py", peru: "pe", poland: "pl", portugal: "pt",
  qatar: "qa", romania: "ro", russia: "ru", "saudi arabia": "sa", scotland: "gb-sct",
  senegal: "sn", serbia: "rs", slovakia: "sk", slovenia: "si", "south africa": "za",
  "south korea": "kr", spain: "es", sweden: "se", switzerland: "ch", tunisia: "tn",
  turkey: "tr", ukraine: "ua", uruguay: "uy", usa: "us", venezuela: "ve", wales: "gb-wls",
};

// alias (normalised) → canonical name, for TxLINE's spelling variants
const ALIASES: Record<string, string> = {
  "korea republic": "south korea", "korea dpr": "south korea", "republic of korea": "south korea",
  "ir iran": "iran", "iran islamic republic": "iran",
  "united states": "usa", "united states of america": "usa",
  "cote divoire": "ivory coast", "czech republic": "czechia", turkiye: "turkey",
  "the netherlands": "netherlands", holland: "netherlands", "republic of ireland": "ireland",
  "great britain": "england",
};

/** ISO flag code for a team name, or null when the nation isn't in the map. */
export function isoForName(name: string): string | null {
  const key = norm(name);
  const canon = ALIASES[key] ?? key;
  return ISO[canon] ?? null;
}

// Static TxLINE ParticipantId → team name (World Cup nations we've seen). Used as
// a fallback so a challenge's team always resolves even after its fixtures drop
// off the live snapshot.
export const TEAM_BY_ID: Record<number, string> = {
  1489: "Argentina", 1575: "Belgium", 1634: "Brazil", 1748: "Colombia",
  1867: "Egypt", 1888: "England", 1999: "France", 2530: "Morocco",
  2545: "Mexico", 2661: "Norway", 2802: "Portugal", 3021: "Spain",
  3099: "Switzerland", 3220: "USA",
};

/** Two-letter fallback shown when a nation isn't in the flag map. */
export function initialsFor(name: string): string {
  return name.replace(/[^A-Za-z ]/g, "").trim().slice(0, 2).toUpperCase() || "??";
}
