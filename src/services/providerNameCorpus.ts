/**
 * Real provider strings that FAILED to resolve in the ticketing app, with their
 * measured failure counts. 90 days to 2026-08-11, from
 * `voice_agent_api_logs.response_body->>'providerSearched'` where
 * `providerMatched = 'false'`.
 *
 * This exists because of lesson F-3 in the ticketing app's own routing map:
 * *"Build vocabulary from real inbound text; keep a regression corpus of real
 * strings."* Every entry here is something a caller actually said, or the
 * schedule actually stored — not something anyone imagined.
 *
 * `inTable` records whether the person exists in the 92-row `providers` table
 * once the name is cleaned. It is the difference between "we broke the match"
 * and "there is nobody to match".
 */

export interface CorpusEntry {
  /** Exactly as it went on the wire. */
  raw: string;
  /** Failed lookups in the 90-day window. */
  n: number;
  /** What the sanitizer should do with it. */
  expect: 'drop' | 'clean' | 'pass';
  /** True when the cleaned name exists in `providers`. */
  inTable?: boolean;
}

export const PROVIDER_FAILURE_CORPUS: CorpusEntry[] = [
  // ---- Diagnostic tests and codes. Never a person. 448 failures. ----
  { raw: 'OCT-VF', n: 217, expect: 'drop' },
  { raw: 'A-Scan', n: 123, expect: 'drop' },
  { raw: 'DRS', n: 108, expect: 'drop' },
  { raw: 'Lipiscan', n: 1, expect: 'drop' },
  { raw: 'Diagnostics', n: 1, expect: 'drop' },
  { raw: 'Testing', n: 3, expect: 'drop' },
  { raw: 'Technician', n: 1, expect: 'drop' },

  // ---- "We don't know who." English and Spanish. ~90 failures. ----
  { raw: 'Unknown', n: 23, expect: 'drop' },
  { raw: 'unknown', n: 2, expect: 'drop' },
  { raw: 'Not yet assigned', n: 5, expect: 'drop' },
  { raw: 'Desconocido', n: 5, expect: 'drop' },
  { raw: 'No especificado', n: 4, expect: 'drop' },
  { raw: 'Not specified', n: 2, expect: 'drop' },
  { raw: 'Not provided', n: 2, expect: 'drop' },
  { raw: 'Not identified', n: 1, expect: 'drop' },
  { raw: 'Not available', n: 1, expect: 'drop' },
  { raw: 'Unavailable', n: 1, expect: 'drop' },
  { raw: 'No asignado', n: 1, expect: 'drop' },
  { raw: 'Not Yet Selected', n: 1, expect: 'drop' },
  { raw: 'unspecified', n: 1, expect: 'drop' },

  // ---- Real people whose credential suffix broke the match. ----
  { raw: 'Todd Mishima, OD', n: 132, expect: 'clean', inTable: true },
  { raw: 'Evelyn Perez, OD', n: 131, expect: 'clean', inTable: false }, // genuinely absent
  { raw: 'Amir Shama, OD', n: 81, expect: 'clean', inTable: true },
  { raw: 'Guadalupe Rocha, OD', n: 18, expect: 'clean', inTable: true },
  { raw: 'Dennis Sugiyama, OD', n: 12, expect: 'clean', inTable: true },
  { raw: 'Minh Shaw, OD', n: 12, expect: 'clean', inTable: true },
  { raw: 'Anthony Huynh, OD', n: 11, expect: 'clean', inTable: true },
  { raw: 'Matthew Diggory, OD', n: 10, expect: 'clean', inTable: true },
  { raw: 'Selena Wong, OD', n: 9, expect: 'clean', inTable: true },
  { raw: 'Sharon Lei, OD', n: 9, expect: 'clean', inTable: true },
  { raw: 'Julia Chu, OD', n: 8, expect: 'clean', inTable: true },
  { raw: 'Nayiri Abnous, OD', n: 8, expect: 'clean', inTable: true },
  { raw: 'Stella Tu, OD', n: 8, expect: 'clean', inTable: true },
  { raw: 'Timothy Hammil, OD', n: 7, expect: 'clean', inTable: true },
  { raw: 'Dana Le, OD', n: 7, expect: 'clean', inTable: true },
  { raw: 'Kevin Tran, OD', n: 7, expect: 'clean', inTable: true },
  { raw: 'Rex Villegas, OD', n: 7, expect: 'clean', inTable: true },
  { raw: 'Sharon Han, OD', n: 7, expect: 'clean', inTable: true },
  { raw: 'Serene Koudsi, OD', n: 7, expect: 'clean', inTable: true },
  { raw: 'Claudia Collins, OD', n: 6, expect: 'clean', inTable: true },
  { raw: 'Christopher Obi, OD', n: 6, expect: 'clean', inTable: true },
  { raw: 'Talin Khachatoor, OD', n: 5, expect: 'clean', inTable: true },
  { raw: 'Jennifer Dang, OD', n: 5, expect: 'clean', inTable: true },
  { raw: 'Eriq Plechot, OD', n: 5, expect: 'clean', inTable: true },
  { raw: 'Agatha Sleboda, OD', n: 5, expect: 'clean', inTable: true },
  { raw: 'Darren Quinton, OD', n: 5, expect: 'clean', inTable: true },
  { raw: 'Nicole Nuha, OD', n: 5, expect: 'clean', inTable: true },
  { raw: 'Lubna Oza, OD', n: 5, expect: 'clean', inTable: true },
  { raw: 'Ashley Szmania, DNP', n: 4, expect: 'clean', inTable: true },
  { raw: 'Jinghui Zhang, OD', n: 4, expect: 'clean', inTable: true },
  { raw: 'Jeanette Tang, OD', n: 4, expect: 'clean', inTable: true },
  { raw: 'Emily Tully-Hanson, OD', n: 4, expect: 'clean', inTable: true },
  { raw: 'Thien-Thu Nguyen, OD', n: 4, expect: 'clean', inTable: true },
  { raw: 'Noelle Bock, OD', n: 3, expect: 'clean', inTable: true },
  { raw: 'Christopher Ciampa, OD', n: 3, expect: 'clean', inTable: true },
  { raw: 'Laura Syniuta, MD', n: 3, expect: 'clean', inTable: true },
  { raw: 'Mimi Phan, OD', n: 2, expect: 'clean', inTable: true },
  { raw: 'Jennie Tran, OD', n: 2, expect: 'clean', inTable: true },
  { raw: 'Mary Cairnie, OD', n: 2, expect: 'clean', inTable: true },
  { raw: 'Liana Hofstadter, OD', n: 2, expect: 'clean', inTable: true },
  { raw: 'Derrick Wang, MD', n: 3, expect: 'clean', inTable: false },

  // ---- Honorific prefix, no suffix. ----
  { raw: 'Dr. Lee', n: 11, expect: 'clean', inTable: false },
  { raw: 'Dr. Dana Lee', n: 10, expect: 'clean', inTable: false },
  { raw: 'Dr. Sarkissian', n: 10, expect: 'clean', inTable: false },
  { raw: 'Dr. Todd Mishima', n: 7, expect: 'clean', inTable: true },
  { raw: 'Dr. Chiu', n: 5, expect: 'clean', inTable: false },
  { raw: 'Dr. Timothy Hamill', n: 4, expect: 'clean', inTable: false },
  { raw: 'Dr. Madavi', n: 4, expect: 'clean', inTable: false },
  { raw: 'Dr. Amir Shama', n: 3, expect: 'clean', inTable: true },
  { raw: 'Dr. Mishima', n: 3, expect: 'clean', inTable: true },
  { raw: 'Dr. Rocha', n: 3, expect: 'clean', inTable: true },
  { raw: 'Dr. Evelyn Perez', n: 3, expect: 'clean', inTable: false },
  { raw: 'Dra. Mora', n: 1, expect: 'clean', inTable: false },

  // ---- Both prefix AND suffix. ----
  { raw: 'Dr. Todd Mishima, OD', n: 1, expect: 'clean', inTable: true },
  { raw: 'Dr. Anthony Huynh, OD', n: 1, expect: 'clean', inTable: true },
  { raw: 'Dr. Sharon Lei, OD', n: 1, expect: 'clean', inTable: true },
  { raw: 'Dr. Jinghui Zhang, OD', n: 1, expect: 'clean', inTable: true },

  // ---- Clean already; must pass through untouched. ----
  { raw: 'Todd Mishima', n: 2, expect: 'pass', inTable: true },
  { raw: 'Emily Nichols', n: 2, expect: 'pass', inTable: false },
  { raw: 'Timoteo', n: 2, expect: 'pass', inTable: false },
  { raw: 'Peter Nguyen', n: 2, expect: 'pass', inTable: false },
  { raw: 'Kimberly Arredondo', n: 4, expect: 'pass', inTable: false },
  { raw: 'Obi', n: 1, expect: 'pass', inTable: true },
  { raw: 'Sarkisian', n: 1, expect: 'pass', inTable: false },
];

/** Names in the live `providers` table, lower-cased, 2026-08-11. */
export const PROVIDERS_SNAPSHOT: string[] = [
  'nayiri abnous', 'adam tanaka', 'payam amini', 'anthony anderson', 'ashley szmania',
  'ashlynne kim', 'noelle bock', 'myles brookman', 'mary cairnie', 'richard casey',
  'eugene chang', 'phoebe chen', 'sylvia chang', 'daniel choi', 'christopher ciampa',
  'julia chu', 'cindy truong', 'jennifer dang', 'darren quinton', 'matthew diggory',
  'emily tully-hanson', 'kweku grant-acquah', 'logan milad haak', 'sharon han',
  'liana hofstadter', 'anthony huynh', 'jinghui zhang', 'farzad khoubian', 'janet kim',
  'dana le', 'sharon lei', 'priscilla luke', 'paymohn mahdavi', 'mailan tran',
  'forrest murphy', 'zacharia nayer', 'meggie nguyen', 'nicole nuha', 'christopher obi',
  'olivia ong', 'lubna oza', 'francisco pabalan', 'jay patel', 'eriq plechot',
  'dorothea remark martinez', 'samira khan', 'theresa sarno', 'selena wong',
  'serene koudsi', 'dennis sugiyama', 'david camara', 'mimi phan', 'talin khachatoor',
  'claudia collins', 'timothy hammil', 'david choi', 'dwayne logan', 'kevin h tran',
  'brett tompkins', 'jennie tran', 'cindy van truong', 'stella tu', 'rex villegas',
  'angela wernow', 'agatha sleboda', 'alvaro torres', 'angela perry', 'brittany powell',
  'farzad jacob khoubian', 'gautam vangipuram', 'genesis atay', 'guadalupe rocha',
  'jeanette tang', 'joni lu', 'kevin tran', 'ledia samwil', 'logan m haak',
  'michael warner', 'minh shaw', 'nhung tran', 'nicole fuerst', 'richard phan',
  'sara javidinejad', 'stevie olney', 'vi nguyen', 'thien-thu nguyen', 'todd mishima',
  'amir shama',
  // The table is not clean either — these carry credentials and an honorific.
  'minh shaw o.d.', 'jeanette tang o.d.', 'dr. laura syniuta',
];
