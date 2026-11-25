/**
 * Partners never receive coordinates (best effort). At none/light redaction
 * the app's packet location ends with "Coordinates: <lat>, <lng>"
 * (escalationPacket.ts buildLocation), which is always removed. Survivors
 * can also type or paste a position into free text; these helpers remove
 * every form we recognise while keeping the textual place description.
 *
 * BEST EFFORT. Recognised forms:
 * - decimal pairs, with "." or "," (four or more digits) as the decimal
 *   mark, joined by a comma, semicolon, slash, pipe, ampersand, plus, %2C,
 *   spaces, or "and"/"na"/"to"/"then"/"au", with an optional sign, degree
 *   mark, or hemisphere letter or word (English or Swahili) before or after
 *   each number: "-4.0435, 39.6682", "S4.0435 E39.6682", "-4,0435 39,6682",
 *   "-4.0435 and 39.6682", "-4.0435|39.6682", "4.0435 kusini 39.6682 mashariki";
 * - compact pairs: "4.0435S39.6682E", "S4.0435E39.6682";
 * - degrees and minutes (and seconds) with symbols or words
 *   ("4°02'36\"S", "4 deg 2 min S");
 * - labelled values, including a whole labelled pair ("lat: -4.04",
 *   "lat-4.0435 long39.6682", "GPS -4.0435", "Coordinates: -4.04, 39.66.");
 * - geo: URIs, map links (Google, Apple, Bing, OpenStreetMap, HERE, Waze,
 *   MapQuest, what3words, plus.codes), any link whose position was removed,
 *   Google plus codes ("6GCRPR6C+24", "PR6C+24") and what3words addresses
 *   ("///word.word.word").
 *
 * Not caught (documented gaps): a single unlabelled number; a pair with
 * fewer decimals than below; a comma-decimal pair with no space
 * ("-4,0435,39,6682"); whole-degree positions without minutes
 * ("4°S 39°E"); a position described in words; and a bare decimal pair
 * (no label, hemisphere or degree mark) outside Kenya and its borders
 * (latitude -6 to 6, longitude 33 to 43), which is treated as ordinary
 * numbers so that unrelated decimals are not withheld.
 *
 * False positives are limited: a number never starts or ends inside
 * another number (so dates like 1.10.2026 and amounts like 40.125 stay
 * whole); a bare pair needs at least three decimals per number in
 * narrative text (two in the location field; three when joined by a word),
 * a plausible latitude/longitude, and is not taken from money ("KSh",
 * "$ 40.125") or clock times ("7.30 pm"); a plus code needs both a letter
 * and a digit. Vehicle plates and whole numbers are never touched.
 *
 * Every pattern uses bounded quantifiers (at most 8 spaces between parts,
 * at most 30 decimals), so each match attempt is constant-time and a field
 * is scrubbed in linear time. Text over MAX_SCRUB_INPUT is withheld whole.
 */

const WITHHELD = '[coordinates withheld]';
export const MAX_SCRUB_INPUT = 32_000;
const TOO_LONG = '[text withheld: too long to check for coordinates]';

const SIGN = '[-+\\u2212]?';
const WS = '\\s{0,8}';
const WS1 = '\\s{1,8}';

const LABEL = '(?:coord(?:inate)?s?|lat(?:itude)?|lng|lon(?:g(?:itude)?)?|gps|geo(?:location)?|location\\s{1,8}pin)';
const DEGREE_MARK = '(?:°|º|deg(?:rees?)?(?![a-z])\\.?)';
const DEGREE = `(?:${WS}${DEGREE_MARK})?`;
const NS_WORDS = 'north|south|kaskazini|kusini';
const EW_WORDS = 'east|west|mashariki|magharibi';
const HEMISPHERE_SUFFIX = `(?:${WS}(?:[NSEW](?![a-z])|(?:${NS_WORDS}|${EW_WORDS})(?![a-z])))?`;
const HEMISPHERE_PREFIX = '(?:(?<![a-z])[NSEW]\\s?)?';
const NOT_TIME = `(?!${WS}(?:a\\.?m\\b|p\\.?m\\b|hrs?\\b|hours?\\b|h\\b))`;
const NOT_MONEY = '(?<!(?:kshs?|kes|shs?|usd|eur|gbp|[$€£])\\.?\\s?)';
// A number never starts or ends inside another number. The first number of
// a pair may not follow a digit, "." or ","; the second follows the joiner,
// so only a digit or "." before it is refused ("-4.0435,39.6682" is a pair).
const FIRST_NUMBER_START = '(?<![\\d.,])';
const SECOND_NUMBER_START = '(?<![\\d.])';
// After a dot-decimal a comma may be the separator ("-4.0435,39.6682");
// after a comma-decimal only ", " can be ("-4,0435, 39,6682").
// A number ends before a digit or before "."/"," followed by a digit (so
// "1.10.2026" stays whole); a sentence's full stop after it is fine
// ("... 39.6682.").
const NUMBER_END = '(?!\\d|\\.\\d)';
const dotDecimal = (minDecimals: number) => `\\d{1,3}\\.\\d{${minDecimals},30}${NUMBER_END}`;
const COMMA_DECIMAL = '\\d{1,3},\\d{4,30}(?!\\d|[.,]\\d)';

function coordinate(minDecimals: number, position: 'first' | 'second'): string {
  const start = position === 'first' ? FIRST_NUMBER_START : SECOND_NUMBER_START;
  return `${HEMISPHERE_PREFIX}${SIGN}${start}(?:${dotDecimal(minDecimals)}|${COMMA_DECIMAL})${NOT_TIME}${DEGREE}${HEMISPHERE_SUFFIX}`;
}

const SYMBOL_JOIN = `(?:${WS}(?:[,;/|&+]|%2C)${WS}|${WS1})`;
const WORD_JOIN = `${WS1}(?:and|na|to|then|au)${WS1}`;

function decimalPair(minDecimals: number): RegExp {
  const symbolPair = `${coordinate(minDecimals, 'first')}${SYMBOL_JOIN}${coordinate(minDecimals, 'second')}`;
  const wordPair = `${coordinate(3, 'first')}${WORD_JOIN}${coordinate(3, 'second')}`;
  return new RegExp(`${NOT_MONEY}(?:${wordPair}|${symbolPair})`, 'gi');
}
const NARRATIVE_PAIR = decimalPair(3);
const LOCATION_PAIR = decimalPair(2);

// "4.0435S39.6682E" and "S4.0435E39.6682": hemisphere letters instead of a separator.
const COMPACT_NUMBER = `${SIGN}${FIRST_NUMBER_START}\\d{1,3}\\.\\d{2,30}${NUMBER_END}`;
const COMPACT_PAIR = new RegExp(
  `${COMPACT_NUMBER}${WS}°?${WS}[NS]${WS}${COMPACT_NUMBER}${WS}°?${WS}[EW](?![a-z])|` +
    `(?<![a-z])[NS]${WS}${COMPACT_NUMBER}${WS}°?${WS}[EW]${WS}${COMPACT_NUMBER}`,
  'gi',
);

const MARKED = new RegExp(`(?:^|[^a-z])[NSEW](?![a-z])|°|º|deg|${NS_WORDS}|${EW_WORDS}`, 'i');
const LABEL_TAIL = new RegExp(`${LABEL}(?![a-z])${WS}[:=]?${WS}$`, 'i');
const NUMBERS = /[-+−]?\d{1,3}(?:[.,]\d{1,30})?/g;
// Kenya with a margin (Kenya spans about -4.7 to 5.0 N and 33.9 to 41.9 E).
const REGION = { lat: [-6, 6], lng: [33, 43] } as const;

function inRegion(lat: number, lng: number): boolean {
  return lat >= REGION.lat[0] && lat <= REGION.lat[1] && lng >= REGION.lng[0] && lng <= REGION.lng[1];
}

/**
 * Whether a matched pair is a position: any plausible latitude/longitude
 * when it carries a label, hemisphere or degree mark; a bare pair only in or
 * near Kenya.
 */
function isPosition(match: string, offset: number, whole: string): boolean {
  const numbers = (match.replace(/%2C/gi, ' ').match(NUMBERS) ?? []).slice(0, 2).map(value => Number(value.replace('−', '-').replace(',', '.')));
  if (numbers.length < 2 || numbers.some(Number.isNaN)) return false;
  const [first, second] = numbers;
  const plausible = (Math.abs(first) <= 90 && Math.abs(second) <= 180) || (Math.abs(first) <= 180 && Math.abs(second) <= 90);
  if (!plausible) return false;
  if (MARKED.test(match) || LABEL_TAIL.test(whole.slice(Math.max(0, offset - 24), offset))) return true;
  return inRegion(first, second) || inRegion(second, first);
}

const DMS = new RegExp(
  `${HEMISPHERE_PREFIX}${FIRST_NUMBER_START}\\d{1,3}(?:[.,]\\d{1,12})?${WS}${DEGREE_MARK}${WS}\\d{1,2}(?:[.,]\\d{1,12})?${WS}(?:['′’]|min(?:ute)?s?(?![a-z])\\.?)` +
    `(?:${WS}\\d{1,2}(?:[.,]\\d{1,12})?${WS}(?:["″”]|''|sec(?:ond)?s?(?![a-z])\\.?))?${HEMISPHERE_SUFFIX}`,
  'gi',
);
// A label then a value: with ":" or "=" any number, otherwise one with two or more decimals.
// The value may be a pair: a second number joined by a symbol (any
// precision) or by spaces (with decimals) is taken too, so a label never
// leaves one half behind ("Coordinates: -4.04, 39.66").
const LABELLED_SECOND = `(?:${WS}[,;/|&]${WS}${SIGN}\\d{1,3}(?:[.,]\\d{1,30})?|${WS1}${SIGN}\\d{1,3}[.,]\\d{1,30})${DEGREE}${HEMISPHERE_SUFFIX}`;
const LABELLED_VALUE = new RegExp(
  `\\b${LABEL}(?![a-z])${WS}(?:[:=]${WS}${SIGN}\\d{1,3}(?:[.,]\\d{1,30})?|${SIGN}\\d{1,3}[.,]\\d{2,30})${DEGREE}${HEMISPHERE_SUFFIX}(?:${LABELLED_SECOND})?`,
  'gi',
);
// A label left in front of a removed value ("Coordinates: [coordinates withheld]").
const LABEL_BEFORE_MARKER = new RegExp(`\\b${LABEL}(?![a-z])${WS}(?:[:=]${WS})?(?=\\[coordinates withheld\\])`, 'gi');
// A location segment that starts with a label ("Coordinates: ...", "GPS -4.04 ...") is dropped whole.
const LABELLED_SEGMENT = new RegExp(`^${WS}${LABEL}(?![a-z])${WS}(?:[:=]|${SIGN}\\d)`, 'i');
const GEO_URI = /\bgeo:\s{0,8}[-+]?\d{1,3}(?:[.,]\d{1,30})?\s{0,8}(?:,|%2C)\s{0,8}[-+]?\d{1,3}(?:[.,]\d{1,30})?\S*/gi;
// Hosts are matched after at most four subdomain labels (no unbounded prefix).
const MAP_HOSTS = '(?:google\\.[a-z.]{2,10}\\/maps|maps\\.google\\.[a-z.]{2,10}|maps\\.app\\.goo\\.gl|goo\\.gl\\/maps|g\\.co\\/kgs|' +
  'bing\\.com\\/maps|binged\\.it|openstreetmap\\.org|osm\\.org|maps\\.apple\\.com|wego\\.here\\.com|share\\.here\\.com|' +
  'mapquest\\.com|waze\\.com|what3words\\.com|w3w\\.co|plus\\.codes)';
const MAP_LINK = new RegExp(`(?:https?:\\/\\/)?(?<![a-z0-9.-])(?:[a-z0-9-]{1,63}\\.){0,4}${MAP_HOSTS}\\S*`, 'gi');
// Google plus codes, full ("6GCRPR6C+24") or short ("PR6C+24"): a letter and a digit are both required.
const PLUS_CODE = /(?<![a-z0-9+])(?:[23456789CFGHJMPQRVWX]{8}|[23456789CFGHJMPQRVWX]{4,6})\+[23456789CFGHJMPQRVWX]{2,3}(?![a-z0-9])/gi;
// what3words addresses written with their prefix: "///index.home.raft" or "w3w: index.home.raft".
const WHAT3WORDS = /(?:\/\/\/|\b(?:w3w|what3words)\b:?\s{0,8}(?:\/\/\/)?)\p{L}{1,30}\.\p{L}{1,30}\.\p{L}{1,30}/giu;
// Any other link that carried a removed position goes whole.
const LINK_WITH_MARKER = /\b(?:https?:\/\/|www\.)\S{0,300}?\[coordinates withheld\]\S*/gi;

function tidy(text: string): string {
  return text
    .replace(/(?:\[coordinates withheld\][\s,;|&]{0,8}){2,}/g, `${WITHHELD} `)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t](?=[,.;|])/g, '')
    .trim();
}

/** Linear trim of spaces and list separators (a regex `[...]+$` would be quadratic). */
function trimSeparators(text: string): string {
  const separator = (char: string) => char === ',' || char === ';' || char === '&' || /\s/.test(char);
  let start = 0;
  let end = text.length;
  while (start < end && separator(text[start])) start += 1;
  while (end > start && separator(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

function removeLinksAndCodes(text: string): string {
  return text
    .replace(MAP_LINK, WITHHELD)
    .replace(GEO_URI, WITHHELD)
    .replace(WHAT3WORDS, WITHHELD)
    .replace(PLUS_CODE, match => (/\d/.test(match) && /[a-z]/i.test(match) ? WITHHELD : match));
}

function removePairs(text: string, pair: RegExp): string {
  return text
    .replace(COMPACT_PAIR, WITHHELD)
    .replace(pair, (match: string, offset: number, whole: string) => (isPosition(match, offset, whole) ? WITHHELD : match))
    .replace(LINK_WITH_MARKER, WITHHELD);
}

function scrubWith(text: string, pair: RegExp): string {
  // Pairs before labels, so a label cannot take one half and leave the other.
  return tidy(removePairs(removeLinksAndCodes(text).replace(DMS, WITHHELD), pair)
    .replace(LABELLED_VALUE, WITHHELD)
    .replace(LABEL_BEFORE_MARKER, ''));
}

/** Removes coordinate forms from free text (best effort), marking where they were. */
export function scrubCoordinates(text: string): string {
  if (text.length > MAX_SCRUB_INPUT) return TOO_LONG;
  return scrubWith(text, NARRATIVE_PAIR);
}

/**
 * The packet location without any coordinates (best effort). Pairs are
 * removed across the whole field first (so "-4.04|39.66" cannot hide behind
 * the segment separator), segments that start with a position label are
 * dropped whole, and any other coordinate form is removed. Only the textual
 * place description stays.
 */
export function scrubPacketLocation(location: string): string {
  if (location.length > MAX_SCRUB_INPUT) return TOO_LONG;
  const kept = removePairs(removeLinksAndCodes(location), LOCATION_PAIR)
    .split('|')
    .filter(segment => !LABELLED_SEGMENT.test(segment))
    .map(segment => trimSeparators(scrubWith(segment, LOCATION_PAIR).split(WITHHELD).join(' ').replace(/\s{2,}/g, ' ')))
    .filter(segment => segment.length > 0);
  return kept.length > 0 ? kept.join(' | ') : 'Place description not provided (coordinates withheld)';
}
