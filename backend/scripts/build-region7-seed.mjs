/**
 * Generates `seeds/0005_region7_catalog_reset.sql` — the **Bohol** academic catalog that replaces
 * seed 0004's nationwide one.
 *
 * The filename still says `region7`, and so do the npm scripts (`seed:region7`,
 * `db:seed:catalog:region7*`). Bohol *is* Region VII, so the name is not wrong, but it is now
 * wider than the contents: the Cebu half was removed (see "Where the data comes from" below).
 * Renaming the file would rename four npm scripts, a CI check and two runbook references for a
 * cosmetic gain, so the name stays and this paragraph is the correction.
 *
 * ## Why a generator and not hand-written SQL
 *
 * Seeds 0002 and 0004 are hand-committed SQL. That works up to a point; 0004 crossed it. The
 * catalog below is 22 campuses × ~6 programmes × ~4 careers each — well over a thousand rows
 * whose ids are content-derived hashes, and every one of the ~880 mapping rows has to name a
 * programme id and a career id that both exist. Hand-maintaining that is not review: nobody can read a
 * 1,500-line wall of UUIDs and notice that one offering points at a career that was renamed.
 *
 * So the *data* lives here, as eight readable tables, and the SQL is output. The emitter resolves
 * every cross-reference by natural key and **throws** on a dangling one, which turns the class of
 * bug that produced audit P1-0 into a build failure instead of a duplicate card on a student's
 * recommendations screen.
 *
 * Both files are committed. The SQL is what runs; this is what it is edited through.
 *
 *     node scripts/build-region7-seed.mjs        # rewrite the seed
 *     node scripts/build-region7-seed.mjs --check # verify the committed seed is current (CI)
 *
 * ## Where the data comes from
 *
 * **`colleges.md`, at the repository root.** It lists 22 Bohol campuses, each with a name, a
 * Google Maps share link and a numbered list of the programmes that campus offers. That document
 * is the whole of the institution, campus, map-link and offering data below; nothing here names a
 * campus or a programme it does not.
 *
 * It replaced two earlier PDFs (`Region VII Education Career Database.pdf` and its `additional`
 * companion, both 2026-09-05, sourced from CHED RO VII directories and PRC / MARINA registers).
 * Those documents covered Bohol **and Cebu** — sixteen institutions — and what survives of them
 * here is the career catalog, the normalisation rules and the licensure statements, none of which
 * `colleges.md` supplies.
 *
 * The rules that survived, and one that changed:
 *
 *   * **The catalog is Bohol, and nothing else.** This is the change. `colleges.md` is a Bohol
 *     document, and the catalog was scoped to match it on instruction — so the twelve Cebu
 *     institutions the PDFs verified (USC, CTU, UP Cebu, USJ-R, Cebu Doctors', PhilSCA, UC,
 *     CIT-U, CNU, Velez, Benedicto, Lapu-Lapu City College) are gone. Bohol is still Region VII;
 *     the catalog is simply narrower than the region now. Git history has the Cebu data if the
 *     scope is ever widened back.
 *   * **A campus is a college row.** BISU's six campuses, BIT's four and Cristal's two are twelve
 *     rows, not three. `colleges.md` gives each its own map link and its own programme list, and
 *     they genuinely differ — BS Fisheries is taught at Calape and Candijay and at no other BISU
 *     campus. Collapsing them would throw away the only part of the answer a student who cannot
 *     relocate actually needs.
 *   * **The 22 campuses below are the source document's set.** CHED RO VII counts 28 HEIs in
 *     Bohol; the rest are absent rather than guessed at.
 *   * **Normalisation preserves scope of practice.** BSCS / BSIT / BSIS / BS CpE stay four
 *     canonical entries because they are four different careers, and BSA stays separate from
 *     BS AIS because only BSA graduates may sit the CPALE. The same rule keeps BS Industrial /
 *     Electrical / Electronics Technology apart from the engineering degrees they resemble — a
 *     technologist is not eligible for the engineering boards, and merging them would say
 *     otherwise. Variant *titles* for one curriculum do collapse: PMI's "BS Maritime
 *     Transportation" and BIT's "BS Marine Transportation" are one canonical programme leading to
 *     one MARINA credential, with each institution's own title kept on its offering row.
 *   * **A degree is not a licence.** Every regulated career's description says which examination
 *     stands between graduation and practice, and under whose authority — the PRC for most,
 *     MARINA under the STCW Convention for deck and marine engineering officers, and the Supreme
 *     Court for the Bar. An automated system must never imply that graduating is enough.
 *
 * Salary bands and `typical_riasec_code` remain **estimates, not measurements** — monthly PHP for
 * the Central Visayas market, Holland codes from the standard occupational interpretation. They
 * are seed values an administrator is expected to refine, and every one is editable in the admin
 * catalog screens. Nothing here is shown to a student as a citation.
 *
 * ## Two things the source documents specify that this schema cannot yet hold
 *
 * 1. **The DIRECT / RELATED / CONDITIONAL / BROAD taxonomy.** `program_careers` is (id,
 *    program_id, career_id) — there is no relationship column, and adding one is a migration plus
 *    a service plus an admin screen, which is not this change. The taxonomy is applied as an
 *    *editorial rule on what gets linked at all*: DIRECT and RELATED are linked, CONDITIONAL is
 *    linked where the credential is the programme's natural destination (Architect for BS
 *    Architecture), and BROAD is **not** linked. Linking BROAD roles would be actively harmful —
 *    §27 averages a programme's linked careers to get its RIASEC score, so attaching
 *    "project management, technical writing" style roles to every programme drags every average
 *    toward the same mean and flattens the ranking this catalog exists to sharpen.
 * 2. **Per-institution accreditation** (PAASCU Level III, AACCUP, CHED COE/COD). There is no
 *    column; it is carried in `colleges.description`, where a student reads it, rather than
 *    dropped.
 *
 * ## Ids
 *
 * UUIDv5 over a fixed namespace, so a given natural key always produces the same id and re-running
 * this generator is a no-op. The namespace is this project's own — seed 0004's derivation was not
 * recorded anywhere and could not be recovered, and since this file *replaces* every row 0004
 * wrote, continuity with it has nothing to preserve. The namespace itself is UUIDv5(DNS,
 * "catalog.careerlinkai.online") so it is reproducible from a string rather than being a magic
 * constant.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'seeds', '0005_region7_catalog_reset.sql');

// --- ids ---------------------------------------------------------------------------------------

const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

function uuidv5(name, namespace) {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1')
    .update(Buffer.concat([namespaceBytes, Buffer.from(name, 'utf8')]))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

const CATALOG_NAMESPACE = uuidv5('catalog.careerlinkai.online', DNS_NAMESPACE);

/** An id for one row, derived from its table and its natural key. */
const id = (table, ...key) => uuidv5(`${table}:${key.join('|')}`, CATALOG_NAMESPACE);

// --- reference ids seeded by migration 0013 ------------------------------------------------------

const OUTLOOK = {
  low: 'e0000001-0000-4000-8000-000000000001',
  moderate: 'e0000002-0000-4000-8000-000000000002',
  high: 'e0000003-0000-4000-8000-000000000003',
  emerging: 'e0000004-0000-4000-8000-000000000004',
};

// --- 1. the region -------------------------------------------------------------------------------
//
// PSGC 9-digit codes. Nullable and advisory in the schema (migration 0011 notes a bulk paste is
// usually names only), carried here because this catalog's whole premise is a geographic boundary
// and the code is the boundary's identifier.

const REGION = { name: 'Region VII (Central Visayas)', code: '070000000' };

const PROVINCES = [
  { name: 'Bohol', code: '071200000' },
];

// The fifteen Bohol municipalities and cities that host an institution in `colleges.md`. Every one
// of them already exists in `towns`, seeded by migration 0011's bulk paste of the Philippine
// address hierarchy — which is names only, with `code` null. The inserts below are
// `INSERT OR IGNORE` and the college rows resolve their town by *name scoped to the province*, so
// what actually happens for all fifteen is that the migration's row wins and this list is inert.
//
// `code` is therefore null rather than a PSGC number. The 9-digit codes for Bohol's 47
// municipalities are not in `colleges.md` and are not in this repository; writing plausible ones
// would put unverified identifiers into the column that exists precisely to be authoritative, and
// they would never be stored anyway. A null says "not recorded", which is true.
const TOWNS = [
  { name: 'Tagbilaran City', province: 'Bohol', code: null },
  { name: 'Balilihan', province: 'Bohol', code: null },
  { name: 'Batuan', province: 'Bohol', code: null },
  { name: 'Bilar', province: 'Bohol', code: null },
  { name: 'Buenavista', province: 'Bohol', code: null },
  { name: 'Calape', province: 'Bohol', code: null },
  { name: 'Candijay', province: 'Bohol', code: null },
  { name: 'Carmen', province: 'Bohol', code: null },
  { name: 'Clarin', province: 'Bohol', code: null },
  { name: 'Jagna', province: 'Bohol', code: null },
  { name: 'Panglao', province: 'Bohol', code: null },
  { name: 'Talibon', province: 'Bohol', code: null },
  { name: 'Trinidad', province: 'Bohol', code: null },
  { name: 'Tubigon', province: 'Bohol', code: null },
  { name: 'Ubay', province: 'Bohol', code: null },
];

// --- 2. institutions (the 22 Bohol campuses of `colleges.md`) -------------------------------------
//
// **A campus is a college row, not a line in a description.** This is the change that separates
// this list from the one it replaces. Bohol Island State University was previously one row whose
// description mentioned six campuses, and BIT International College one row mentioning four — so
// "which colleges offer BS Fisheries?" answered "BISU", and a student in Candijay had no way to
// learn that the Candijay campus is the one that teaches it while the Tagbilaran main campus does
// not. Every campus below has its own town, its own programme list and its own map link, because
// those three things genuinely differ per campus and a student's question is always about one.
//
// `map` is the institution's own Google Maps share link, taken verbatim from `colleges.md`. These
// are real `maps.app.goo.gl` pins, which is a strict improvement on the synthesised
// `/maps/search/?query=<name>` URLs this seed used to emit — a search URL is a guess the browser
// resolves, a share link is the place. One campus (BIT Carmen) has no link in the source document;
// it is `null` here and the emitter falls back to a name search rather than inventing a pin.
//
// Descriptions state what the source document supports and stop there. The four institutions that
// were already in this catalog (BISU, HNU, UB, BIT) keep their verified accreditation sentences;
// the thirteen that `colleges.md` adds get a factual line about campus and offerings, with no
// accreditation claim, because this repository has nothing that would substantiate one.

const COLLEGES = [
  // --- Bohol Island State University — the state university, six campuses -------------------
  {
    key: 'BISU_MAIN',
    name: 'Bohol Island State University - Main Campus',
    town: 'Tagbilaran City',
    map: 'https://maps.app.goo.gl/cwMMxcspn8QxgXs49',
    description:
      'The main campus of the state university of Bohol, in Tagbilaran City, and the only BISU campus offering the engineering and architecture programmes. AACCUP accredited and WURI 2026 ranked.',
  },
  {
    key: 'BISU_BALILIHAN',
    name: 'Bohol Island State University - Balilihan Campus',
    town: 'Balilihan',
    map: 'https://maps.app.goo.gl/pJd8oYqeXrRP6x5k7',
    description:
      'The Balilihan campus of Bohol Island State University, concentrating on computing, industrial and electrical technology, and criminology.',
  },
  {
    key: 'BISU_BILAR',
    name: 'Bohol Island State University - Bilar Campus',
    town: 'Bilar',
    map: 'https://maps.app.goo.gl/BcH4bLwVZ45GrEDx5',
    description:
      'The Bilar campus of Bohol Island State University, the agriculture and forestry campus, alongside computer science and teacher education.',
  },
  {
    key: 'BISU_CALAPE',
    name: 'Bohol Island State University - Calape Campus',
    town: 'Calape',
    map: 'https://maps.app.goo.gl/TqKYyqY4ivSFwQgj6',
    description:
      'The Calape campus of Bohol Island State University, offering fisheries, food technology, midwifery, industrial technology, computer science and teacher education.',
  },
  {
    key: 'BISU_CLARIN',
    name: 'Bohol Island State University - Clarin Campus',
    town: 'Clarin',
    map: 'https://maps.app.goo.gl/dHJHgnpGYquPKZt89',
    description:
      'The Clarin campus of Bohol Island State University, offering environmental science, hospitality management, computer science and teacher education.',
  },
  {
    key: 'BISU_CANDIJAY',
    name: 'Bohol Island State University - Candijay Campus',
    town: 'Candijay',
    map: 'https://maps.app.goo.gl/vWqSk94PCqDMDdSA6',
    description:
      'The Candijay campus of Bohol Island State University, on the east coast, and the campus that teaches marine biology and fisheries.',
  },

  // --- The Tagbilaran private universities ---------------------------------------------------
  {
    key: 'UB',
    name: 'University of Bohol',
    town: 'Tagbilaran City',
    map: 'https://maps.app.goo.gl/P9zFTPQ1hTz7UNpf9',
    description:
      'A private non-sectarian comprehensive university in Poblacion, Tagbilaran City, with programmes spanning liberal arts, criminology, business, engineering, health sciences and civil law. PACUCOA accredited.',
  },
  {
    key: 'HNU',
    name: 'Holy Name University',
    town: 'Tagbilaran City',
    map: 'https://maps.app.goo.gl/DWZoBLASrVhmqnc68',
    description:
      'The principal private university of Bohol, an SVD institution on the Dampas campus in Tagbilaran City, offering nursing, accountancy, engineering, computing and teacher education. PAASCU Level III accredited.',
  },

  // --- BIT International College — four campuses ---------------------------------------------
  {
    key: 'BIT_TAGBILARAN',
    name: 'BIT International College - Tagbilaran Campus',
    town: 'Tagbilaran City',
    map: 'https://maps.app.goo.gl/cd1HDDGuhP4VJz198',
    description:
      'The Tagbilaran City campus of BIT International College, a private non-sectarian college, and the only BIT campus offering marine transportation alongside computing, business, hospitality and criminology.',
  },
  {
    key: 'BIT_CARMEN',
    name: 'BIT International College - Carmen Campus',
    town: 'Carmen',
    map: null,
    description:
      'The Carmen campus of BIT International College, offering information technology, hospitality management and criminology.',
  },
  {
    key: 'BIT_JAGNA',
    name: 'BIT International College - Jagna Campus',
    town: 'Jagna',
    map: 'https://maps.app.goo.gl/UBpv3GfshnfJzNBg6',
    description:
      'The Jagna campus of BIT International College, offering information technology, business administration and hospitality management.',
  },
  {
    key: 'BIT_TALIBON',
    name: 'BIT International College - Talibon Campus',
    town: 'Talibon',
    map: 'https://maps.app.goo.gl/sVBi35aqRstJfGPE6',
    description:
      'The Talibon campus of BIT International College, in northern Bohol, offering information technology, hospitality management and criminology.',
  },

  // --- The provincial private colleges -------------------------------------------------------
  {
    key: 'MATERDEI',
    name: 'Mater Dei College',
    town: 'Tubigon',
    map: 'https://maps.app.goo.gl/wujaoZYySyfN8sob6',
    description:
      'A private college in Tubigon, western Bohol, and one of the few institutions outside Tagbilaran offering nursing and midwifery, alongside business, computing, hospitality, tourism, criminology and teacher education.',
  },
  {
    key: 'BNSC',
    name: 'Bohol Northern Star Colleges',
    town: 'Ubay',
    map: 'https://maps.app.goo.gl/D9d48vQq6aWLobNQ6',
    description:
      'A private college in Ubay, northeastern Bohol, offering criminology, business administration, hospitality management and teacher education.',
  },
  {
    key: 'PMI',
    name: 'Philippine Maritime Institute - Bohol',
    town: 'Tagbilaran City',
    map: 'https://maps.app.goo.gl/YpY9SCGRGpZhFog89',
    description:
      'The Bohol campus of the Philippine Maritime Institute, a maritime-only institution offering marine transportation and marine engineering. Both are MARINA/STCW credential paths rather than PRC ones.',
  },
  {
    key: 'CRISTAL_TAGBILARAN',
    name: 'Cristal e-College - Tagbilaran Campus',
    town: 'Tagbilaran City',
    map: 'https://maps.app.goo.gl/LCPArDab5danWVFB9',
    description:
      'The Tagbilaran City campus of Cristal e-College, offering information technology, business administration and tourism management.',
  },
  {
    key: 'CRISTAL_PANGLAO',
    name: 'Cristal e-College - Panglao Campus',
    town: 'Panglao',
    map: 'https://maps.app.goo.gl/gNd9dQvxqcRDHzVdA',
    description:
      'The Panglao campus of Cristal e-College, on the island, pairing tourism and information technology with the maritime programmes the Tagbilaran campus does not offer.',
  },

  // --- The LUC tier — municipal and city colleges ---------------------------------------------
  //
  // Five institutions funded by a municipal or city ordinance rather than by CHED or by tuition.
  // They matter to this catalog out of proportion to their programme counts: they are the only
  // higher education in their municipality, and for a student who cannot relocate to Tagbilaran
  // the three programmes at Batuan College are not a short list, they are the list.
  {
    key: 'BUENAVISTA_CC',
    name: 'Buenavista Community College',
    town: 'Buenavista',
    map: 'https://maps.app.goo.gl/CD7kEMNQ8t8DS3zAA',
    description:
      'The community college of Buenavista, northern Bohol, offering business administration, information technology, criminology and elementary education.',
  },
  {
    key: 'TRINIDAD_MC',
    name: 'Trinidad Municipal College',
    town: 'Trinidad',
    map: 'https://maps.app.goo.gl/EC8zB2SpL7woPMdb9',
    description:
      'The municipal college of Trinidad, offering business administration, public administration and elementary education.',
  },
  {
    key: 'BATUAN_COLLEGE',
    name: 'Batuan College',
    town: 'Batuan',
    map: 'https://maps.app.goo.gl/kzzhSChu39ga17j98',
    description:
      'The municipal college of Batuan, interior Bohol, offering elementary education, secondary education and business administration.',
  },
  {
    key: 'TALIBON_POLY',
    name: 'Talibon Polytechnic College',
    town: 'Talibon',
    map: 'https://maps.app.goo.gl/5iguk1Mf4FmCZ8aL9',
    description:
      'The polytechnic college of Talibon, and the broadest LUC offering in the province: agriculture, accounting information systems, information systems, criminology, political science and English language.',
  },
  {
    key: 'TAGBILARAN_CC',
    name: 'Tagbilaran City College',
    town: 'Tagbilaran City',
    map: 'https://maps.app.goo.gl/XrDVGr4unn2R77hPA',
    description:
      'The city college of Tagbilaran, offering entrepreneurship and hospitality management.',
  },
];

// --- 3. careers ----------------------------------------------------------------------------------
//
// Every career here is reachable from a programme one of the institutions above actually
// offers — the emitter enforces it, so a career nothing maps to is a build failure rather than a
// row that quietly never appears in anyone's ranking.
//
// `riasec` is read **positionally** by §27, weighted [0.5, 0.3, 0.2]. Letter order is data.
//
// Descriptions of regulated professions name the statute and the PRC examination, per the PDF's
// rule that an automated system must never let a degree read as a licence.

const CAREERS = [
  // Computing and information technology
  {
    title: 'Software Developer',
    description:
      'Designs, builds and maintains software systems, from backend services to full-stack web applications. Not a regulated profession — employers hire on portfolio and industry certifications (AWS, Oracle, Microsoft) rather than a PRC licence.',
    min: 30000,
    max: 140000,
    outlook: OUTLOOK.high,
    riasec: 'IEC',
  },
  {
    title: 'Data Scientist',
    description:
      'Builds statistical and machine-learning models to answer business and research questions. Non-regulated; machine-learning and cloud certifications are the usual credential. Common in Cebu analytics firms, FinTech and research units.',
    min: 55000,
    max: 180000,
    outlook: OUTLOOK.emerging,
    riasec: 'IRC',
  },
  {
    title: 'Data Analyst',
    description:
      'Turns operational data into decisions using statistics, SQL and visualisation. Non-regulated. A common first analytics role in the Cebu IT-BPO sector.',
    min: 28000,
    max: 95000,
    outlook: OUTLOOK.high,
    riasec: 'ICE',
  },
  {
    title: 'Cybersecurity Analyst',
    description:
      'Defends systems and networks against intrusion and data loss, running monitoring, incident response and vulnerability management. Non-regulated; credentialed through industry certifications.',
    min: 40000,
    max: 140000,
    outlook: OUTLOOK.emerging,
    riasec: 'ICR',
  },
  {
    title: 'Network Engineer',
    description:
      'Designs and operates the networks an organisation runs on, including routing, switching and network security. Non-regulated, though a BS Electronics Engineering route to this role carries the PRC Electronics Engineer licence.',
    min: 30000,
    max: 100000,
    outlook: OUTLOOK.moderate,
    riasec: 'RCI',
  },
  {
    title: 'Systems Administrator',
    description:
      'Keeps servers, identity systems and infrastructure running, patched and backed up. Non-regulated; vendor certifications are the usual credential.',
    min: 25000,
    max: 90000,
    outlook: OUTLOOK.moderate,
    riasec: 'CRI',
  },
  {
    title: 'Database Administrator',
    description:
      'Designs, tunes and safeguards the databases an organisation depends on, including backup and recovery. Non-regulated.',
    min: 32000,
    max: 110000,
    outlook: OUTLOOK.moderate,
    riasec: 'CIR',
  },
  {
    title: 'Business Systems Analyst',
    description:
      'Translates business processes into system requirements and works between operations and development teams. Non-regulated; the usual route from an information systems or business computing degree.',
    min: 35000,
    max: 120000,
    outlook: OUTLOOK.high,
    riasec: 'CIE',
  },
  {
    title: 'Quality Assurance Engineer',
    description:
      'Designs and runs the test suites that decide whether software ships, both manual and automated. Non-regulated.',
    min: 25000,
    max: 95000,
    outlook: OUTLOOK.high,
    riasec: 'CIR',
  },
  {
    title: 'IT Support Specialist',
    description:
      'First-line technical support for users, devices and business applications. Non-regulated; a common entry point into the Cebu IT-BPO sector.',
    min: 18000,
    max: 55000,
    outlook: OUTLOOK.high,
    riasec: 'CRS',
  },
  {
    title: 'UI/UX Designer',
    description:
      'Researches and designs how people move through digital products, from user research to interface specification. Non-regulated; hired on portfolio.',
    min: 30000,
    max: 110000,
    outlook: OUTLOOK.high,
    riasec: 'AIE',
  },
  {
    title: 'Cloud Infrastructure Engineer',
    description:
      'Builds and operates cloud platforms and deployment pipelines. Non-regulated; AWS, Azure and GCP certifications are the recognised credential.',
    min: 45000,
    max: 160000,
    outlook: OUTLOOK.emerging,
    riasec: 'IEC',
  },

  // Engineering and the built environment
  {
    title: 'Civil Engineer',
    description:
      'Performs structural calculation, construction sign-off and public works management on buildings, roads and drainage. Regulated under RA 544: a BS Civil Engineering degree grants eligibility only, and practice requires passing the PRC Civil Engineering Licensure Examination and registering with the Board.',
    min: 28000,
    max: 110000,
    outlook: OUTLOOK.high,
    riasec: 'RIC',
  },
  {
    title: 'Construction Project Manager',
    description:
      'Runs construction projects against programme, budget and quality — scheduling, subcontractors and site coordination. Not separately licensed, but a PRC engineering or architecture licence is normally expected on public works.',
    min: 45000,
    max: 150000,
    outlook: OUTLOOK.high,
    riasec: 'ERC',
  },
  {
    title: 'Quantity Surveyor',
    description:
      'Prepares construction cost estimates, bills of quantities and progress valuations for contractors and developers. Non-regulated in the Philippines, though it is normally staffed from engineering and architecture graduates.',
    min: 25000,
    max: 90000,
    outlook: OUTLOOK.moderate,
    riasec: 'CRI',
  },
  {
    title: 'Architect',
    description:
      'Produces architectural design, structural signing and urban planning consultation. Regulated under RA 9266: a BS Architecture degree is followed by two years (3,840 hours) of diversified architectural mentorship under a licensed architect, and only then the Licensure Examination for Architects.',
    min: 28000,
    max: 120000,
    outlook: OUTLOOK.moderate,
    riasec: 'AIR',
  },
  {
    title: 'Industrial Designer',
    description:
      'Designs manufactured products — furniture, equipment, packaging and consumer goods — from concept and prototype through to production drawings. Non-regulated; hired on portfolio.',
    min: 20000,
    max: 65000,
    outlook: OUTLOOK.moderate,
    riasec: 'AIR',
  },
  {
    title: 'Interior Designer',
    description:
      'Plans interior spaces, materials and detailing for residential and commercial fit-outs. Regulated under RA 10350 — practice requires passing the PRC Interior Design Licensure Examination.',
    min: 22000,
    max: 90000,
    outlook: OUTLOOK.moderate,
    riasec: 'AER',
  },
  {
    title: 'Mechanical Engineer',
    description:
      'Designs and maintains machinery, thermal systems and manufacturing plant. Regulated under RA 8495 — practice requires passing the PRC Mechanical Engineer Licensure Examination.',
    min: 28000,
    max: 110000,
    outlook: OUTLOOK.high,
    riasec: 'RIC',
  },
  {
    title: 'Electrical Engineer',
    description:
      'Designs power systems, machines and building electrical services. Regulated under RA 7920 — practice requires passing the PRC Electrical Engineer Licensure Examination.',
    min: 30000,
    max: 115000,
    outlook: OUTLOOK.high,
    riasec: 'RIC',
  },
  {
    title: 'Agricultural and Biosystems Engineer',
    description:
      'Designs farm machinery, irrigation and drainage systems, post-harvest facilities and agricultural processing plant. Regulated under RA 10915 — practice requires passing the PRC Agricultural and Biosystems Engineering Licensure Examination.',
    min: 22000,
    max: 65000,
    outlook: OUTLOOK.moderate,
    riasec: 'RIE',
  },
  {
    title: 'Industrial Technologist',
    description:
      'Supervises manufacturing, machine shop, welding and industrial maintenance work in plants and workshops. Not a PRC-licensed engineering title — a BS Industrial Technology graduate is not eligible for the engineering board examinations, and the credentials that advance this career are TESDA National Certificates.',
    min: 15000,
    max: 42000,
    outlook: OUTLOOK.moderate,
    riasec: 'REC',
  },
  {
    title: 'Electrical Technician',
    description:
      'Installs, tests and maintains building wiring, motor controls and electrical equipment to Philippine Electrical Code practice. Distinct from a licensed Electrical Engineer: the ladder here runs through the PRC Registered Master Electrician examination and TESDA certification, not the engineering board.',
    min: 14000,
    max: 38000,
    outlook: OUTLOOK.moderate,
    riasec: 'RCI',
  },
  {
    title: 'Electronics Technician',
    description:
      'Services, calibrates and repairs electronic instrumentation, communications and control equipment. Not the licensed Electronics Engineer title under RA 9292 — this is the technician track, credentialled through TESDA and the PRC Electronics Technician examination.',
    min: 14000,
    max: 38000,
    outlook: OUTLOOK.moderate,
    riasec: 'RCE',
  },
  {
    title: 'Forester',
    description:
      'Manages forest stands, watersheds, reforestation and agroforestry programmes for DENR, LGUs and private plantations. Regulated under RA 6239 — practice requires passing the PRC Foresters Licensure Examination.',
    min: 20000,
    max: 55000,
    outlook: OUTLOOK.moderate,
    riasec: 'RIS',
  },
  {
    title: 'Computer Engineer',
    description:
      'Works at the hardware-software boundary: digital systems, embedded design and computer architecture. Non-regulated, and distinct from computer science — the curriculum is built around circuits and embedded systems rather than algorithms.',
    min: 32000,
    max: 120000,
    outlook: OUTLOOK.high,
    riasec: 'IRE',
  },
  {
    title: 'Embedded Systems Engineer',
    description:
      'Writes firmware and designs the hardware-software boundary for microcontrollers, industrial controllers and connected devices. Non-regulated; the credential is demonstrated low-level work.',
    min: 30000,
    max: 100000,
    outlook: OUTLOOK.high,
    riasec: 'IRE',
  },
  {
    title: 'Instrumentation Technician',
    description:
      'Installs, calibrates and troubleshoots sensors, transmitters and process control loops in plants, utilities and food processing lines. Credentialled through TESDA National Certificates rather than a PRC board.',
    min: 18000,
    max: 48000,
    outlook: OUTLOOK.moderate,
    riasec: 'RCE',
  },
  {
    title: 'Maintenance Engineer',
    description:
      'Plans and supervises preventive and corrective maintenance for plant, building systems and production equipment. Non-regulated as a title, though supervising electrical or mechanical work at scale generally requires the corresponding PRC licence.',
    min: 25000,
    max: 75000,
    outlook: OUTLOOK.moderate,
    riasec: 'RCS',
  },
  {
    title: 'Renewable Energy Specialist',
    description:
      'Sizes, installs and commissions solar, wind and hybrid generation and storage systems, and handles the grid-connection and net-metering paperwork. Non-regulated as a title; design sign-off on a distribution system requires a licensed Electrical Engineer.',
    min: 28000,
    max: 90000,
    outlook: OUTLOOK.emerging,
    riasec: 'IRS',
  },
  {
    title: 'Occupational Health and Safety Officer',
    description:
      'Runs workplace hazard assessment, safety training and incident investigation on sites and in plants. Required by DOLE Department Order 198-18: the role needs an accredited Safety Officer certification (SO1-SO4) earned through mandatory training on top of the degree, not the degree alone.',
    min: 18000,
    max: 60000,
    outlook: OUTLOOK.high,
    riasec: 'RSC',
  },
  {
    title: 'Marine Engineer',
    description:
      'Operates and maintains shipboard machinery and propulsion systems. Regulated under the STCW Convention and RA 10635 — practice requires a MARINA/PRC Certificate of Competency following approved sea service.',
    min: 40000,
    max: 200000,
    outlook: OUTLOOK.high,
    riasec: 'RCE',
  },

  // Aviation

  // Health sciences
  {
    title: 'Registered Nurse',
    description:
      'Delivers direct clinical care, patient assessment and bedside nursing in hospitals and clinics. Regulated under RA 9173: a BS Nursing degree grants eligibility only, and practice requires passing the Nurse Licensure Examination and holding a PRC Certificate of Registration.',
    min: 22000,
    max: 70000,
    outlook: OUTLOOK.high,
    riasec: 'SIR',
  },
  {
    title: 'Pharmacist',
    description:
      'Dispenses medicines and advises on pharmaceutical care in hospital, retail and industry settings. Regulated under RA 10918 — practice requires passing the PRC Pharmacist Licensure Examination.',
    min: 26000,
    max: 85000,
    outlook: OUTLOOK.moderate,
    riasec: 'ICS',
  },
  {
    title: 'Physical Therapist',
    description:
      'Rehabilitates movement and physical function after injury, surgery or illness. Regulated under RA 5680 — practice requires passing the PRC Physical Therapist Licensure Examination.',
    min: 24000,
    max: 80000,
    outlook: OUTLOOK.high,
    riasec: 'SIR',
  },
  {
    title: 'Midwife',
    description:
      'Provides prenatal, delivery, postnatal and newborn care in birthing homes, rural health units and hospitals. Regulated under RA 7392 — practice requires passing the PRC Midwifery Licensure Examination.',
    min: 15000,
    max: 38000,
    outlook: OUTLOOK.moderate,
    riasec: 'SRI',
  },
  {
    title: 'Regulatory Affairs Specialist',
    description:
      'Prepares product registrations, licence renewals and compliance dossiers for the Philippine FDA in pharmaceutical, food and device companies. Non-regulated as a title, but the work is defined by FDA circulars.',
    min: 25000,
    max: 75000,
    outlook: OUTLOOK.moderate,
    riasec: 'CIE',
  },
  {
    title: 'Medical Sales Representative',
    description:
      'Details pharmaceutical and medical products to physicians, hospitals and pharmacies. Non-regulated; earnings are substantially commission, so the range below is wider in practice than a salaried role.',
    min: 18000,
    max: 65000,
    outlook: OUTLOOK.moderate,
    riasec: 'ESI',
  },
  {
    title: 'Sports Rehabilitation Specialist',
    description:
      'Manages injury prevention, conditioning and return-to-play rehabilitation for athletes and active patients. Where the work is physical therapy it requires the PRC Physical Therapist licence under RA 5680; conditioning and strength coaching do not.',
    min: 20000,
    max: 60000,
    outlook: OUTLOOK.moderate,
    riasec: 'SRI',
  },
  {
    title: 'Clinical Researcher',
    description:
      'Coordinates clinical trials — monitoring, medical documentation and patient consent protocols — for pharmaceutical companies and research organisations. Non-regulated; Good Clinical Practice (GCP) certification is the usual credential.',
    min: 32000,
    max: 110000,
    outlook: OUTLOOK.emerging,
    riasec: 'ISC',
  },
  {
    title: 'Public Health Officer',
    description:
      'Runs community health programmes, surveillance and health promotion for LGUs and health agencies. Not separately licensed, though most posts require an underlying health profession licence.',
    min: 28000,
    max: 90000,
    outlook: OUTLOOK.moderate,
    riasec: 'SIE',
  },

  // Accountancy, finance and business
  {
    title: 'Certified Public Accountant',
    description:
      'Performs external auditing, public accounting and corporate financial reporting. Regulated under RA 9298: only BS Accountancy graduates may sit the CPA Licensure Examination, and the title may be used only after passing it, taking the oath and registering with the PRC Board of Accountancy.',
    min: 32000,
    max: 150000,
    outlook: OUTLOOK.high,
    riasec: 'CEI',
  },
  {
    title: 'Financial Analyst',
    description:
      'Builds financial models, variance analysis and budgets for corporations, banks and BPO finance operations. Non-regulated; the CFA is an optional international credential rather than a legal requirement.',
    min: 32000,
    max: 120000,
    outlook: OUTLOOK.high,
    riasec: 'CIE',
  },
  {
    title: 'Internal Auditor',
    description:
      'Tests internal controls, compliance and process risk from inside the organisation. A non-licensure track — Certified Internal Auditor (CIA) certification rather than PRC registration.',
    min: 32000,
    max: 115000,
    outlook: OUTLOOK.high,
    riasec: 'CIE',
  },
  {
    title: 'Operations Manager',
    description:
      'Runs supply chain, process and workforce performance across manufacturing, retail and logistics. Non-regulated; PMP and lean certifications are optional.',
    min: 42000,
    max: 150000,
    outlook: OUTLOOK.high,
    riasec: 'ECS',
  },
  {
    title: 'Supply Chain Analyst',
    description:
      'Plans inventory, demand and logistics flows, and measures where cost and delay accumulate. Non-regulated.',
    min: 28000,
    max: 95000,
    outlook: OUTLOOK.high,
    riasec: 'CEI',
  },
  {
    title: 'Marketing Specialist',
    description:
      'Plans and runs campaigns, brand work and market research. Non-regulated.',
    min: 22000,
    max: 90000,
    outlook: OUTLOOK.high,
    riasec: 'EAS',
  },
  {
    title: 'Human Resources Specialist',
    description:
      'Handles recruitment, job evaluation, organisational development and performance appraisal. Non-regulated; SHRM or CHRA certification is optional. A common destination for psychology graduates in Cebu corporate HR and BPO talent acquisition.',
    min: 22000,
    max: 85000,
    outlook: OUTLOOK.high,
    riasec: 'SEC',
  },
  {
    title: 'Office Administrator',
    description:
      'Runs office systems, records, correspondence, scheduling and administrative support for a business unit or agency. Non-regulated; government appointments require Civil Service eligibility.',
    min: 14000,
    max: 35000,
    outlook: OUTLOOK.moderate,
    riasec: 'CES',
  },
  {
    title: 'Executive Assistant',
    description:
      'Manages the calendar, correspondence, records and travel of an executive or department, and coordinates across the units reporting to them. Non-regulated.',
    min: 16000,
    max: 45000,
    outlook: OUTLOOK.moderate,
    riasec: 'CSE',
  },
  {
    title: 'Bank Operations Officer',
    description:
      'Runs branch and back-office banking operations, compliance checks and client accounts. Non-regulated, though BSP-supervised roles carry their own fit-and-proper requirements.',
    min: 22000,
    max: 80000,
    outlook: OUTLOOK.moderate,
    riasec: 'CES',
  },
  {
    title: 'Hotel Operations Manager',
    description:
      'Runs rooms, food and beverage and events operations in hotels and resorts. Non-regulated. A substantial employer across Cebu, Mactan and Panglao.',
    min: 28000,
    max: 100000,
    outlook: OUTLOOK.high,
    riasec: 'ESC',
  },
  {
    title: 'Tourism Officer',
    description:
      'Plans destination marketing, tour operations and visitor services for LGUs and travel operators. Non-regulated, though DOT accreditation applies to the establishments employing them.',
    min: 20000,
    max: 70000,
    outlook: OUTLOOK.moderate,
    riasec: 'ESA',
  },
  {
    title: 'Events Manager',
    description:
      'Plans and runs weddings, conferences and corporate events end to end — suppliers, budget, programme and on-the-day operations. Non-regulated; a substantial market across Panglao and Tagbilaran.',
    min: 18000,
    max: 60000,
    outlook: OUTLOOK.moderate,
    riasec: 'ESA',
  },
  {
    title: 'Food and Beverage Supervisor',
    description:
      'Supervises restaurant, banquet and bar operations — service standards, costing, inventory and food safety compliance. Non-regulated, though kitchens operate under local sanitation permits.',
    min: 15000,
    max: 40000,
    outlook: OUTLOOK.moderate,
    riasec: 'ECS',
  },
  {
    title: 'Tour Operations Manager',
    description:
      'Builds and runs tour products and itineraries, manages guides and transport, and handles DOT accreditation for the operator. Non-regulated as a title; tour guiding itself requires DOT accreditation.',
    min: 18000,
    max: 55000,
    outlook: OUTLOOK.moderate,
    riasec: 'ESC',
  },
  {
    title: 'Entrepreneur',
    description:
      'Starts and runs a business, carrying its commercial and operational risk. Not a regulated profession; the constraints are capital, registration and the market.',
    min: 20000,
    max: 200000,
    outlook: OUTLOOK.moderate,
    riasec: 'ECS',
  },

  // Education
  {
    title: 'Elementary School Teacher',
    description:
      'Teaches the K-6 curriculum in public and private elementary schools. Regulated under RA 7836 and RA 9293 — a BEEd degree grants eligibility, and teaching requires passing the Licensure Examination for Teachers and PRC registration.',
    min: 27000,
    max: 50000,
    outlook: OUTLOOK.high,
    riasec: 'SAE',
  },
  {
    title: 'Secondary School Teacher',
    description:
      'Teaches a subject specialisation in junior and senior high school. Regulated under RA 7836 and RA 9293 — a BSEd degree grants eligibility, and teaching requires passing the Licensure Examination for Teachers.',
    min: 27000,
    max: 55000,
    outlook: OUTLOOK.high,
    riasec: 'SAE',
  },

  // Psychology, social work and public safety
  {
    title: 'Physical Education Teacher',
    description:
      'Teaches physical education and coaches school athletics programmes. Regulated under RA 7836 — a BPEd degree grants eligibility, and teaching requires passing the Licensure Examination for Teachers.',
    min: 27000,
    max: 48000,
    outlook: OUTLOOK.high,
    riasec: 'SRE',
  },
  {
    title: 'School Administrator',
    description:
      'Leads a school or department — instructional supervision, staffing, compliance and DepEd reporting. A progression from teaching rather than an entry role: it requires the PRC teaching licence plus classroom experience, and public school principalship additionally requires the DepEd principals’ examination.',
    min: 35000,
    max: 80000,
    outlook: OUTLOOK.moderate,
    riasec: 'SEC',
  },
  {
    title: 'Athletic Coach',
    description:
      'Trains and manages school, club or LGU athletic teams, including conditioning, competition entry and athlete development. Non-regulated; national sport associations run their own coaching accreditation.',
    min: 15000,
    max: 48000,
    outlook: OUTLOOK.moderate,
    riasec: 'SER',
  },
  {
    title: 'Psychometrician',
    description:
      'Administers and scores standardised psychological tests and conducts behavioural observation in testing centres, schools and clinics. Regulated under RA 10029 — a BS or BA Psychology degree grants eligibility for the Psychometrician Licensure Examination. Practising as a Clinical Psychologist is a separate path requiring a Master’s degree and the Psychologist Licensure Examination.',
    min: 20000,
    max: 60000,
    outlook: OUTLOOK.high,
    riasec: 'ISC',
  },
  {
    title: 'Guidance Counselor',
    description:
      'Provides academic, career and personal counselling in schools. Regulated under RA 9258 — requires a Master’s degree in guidance and counselling and the PRC Guidance Counselor Licensure Examination, so it is a graduate-level destination rather than a first job.',
    min: 26000,
    max: 70000,
    outlook: OUTLOOK.moderate,
    riasec: 'SIA',
  },
  {
    title: 'Registered Criminologist',
    description:
      'Works in law enforcement, criminal investigation and correctional management. Regulated under RA 11131 — requires passing the PRC Criminologist Licensure Examination, and entry into the PNP additionally requires its own appointment and clearance process.',
    min: 29000,
    max: 70000,
    outlook: OUTLOOK.high,
    riasec: 'RSE',
  },
  {
    title: 'Crime Scene Investigator',
    description:
      'Handles evidence recovery, latent fingerprint processing and forensic documentation for the NBI and the PNP Forensic Group. Requires the PRC Criminologist Licensure Examination under RA 11131.',
    min: 28000,
    max: 85000,
    outlook: OUTLOOK.moderate,
    riasec: 'IRS',
  },

  // Environment, marine, agriculture and the sciences
  {
    title: 'Fisheries Technologist',
    description:
      'Runs fish hatchery operations, water quality analysis, feed formulation and aquatic pathology on commercial farms and for BFAR. Regulated under RA 8550 as amended by RA 10654 — practice requires passing the PRC Fisheries Technologist Licensure Examination.',
    min: 24000,
    max: 70000,
    outlook: OUTLOOK.moderate,
    riasec: 'RIE',
  },
  {
    title: 'Agriculturist',
    description:
      'Advises on crop and animal production, farm systems and extension work. Regulated under RA 8435 — practice as a professional agriculturist requires passing the PRC Agriculturist Licensure Examination.',
    min: 20000,
    max: 65000,
    outlook: OUTLOOK.moderate,
    riasec: 'RIE',
  },
  {
    title: 'Food Technologist',
    description:
      'Develops food products and runs processing, preservation, quality assurance and food-safety systems (HACCP, GMP) in manufacturing plants and for regulators. Non-regulated as a title, though food-safety practice is governed by FDA and DA standards.',
    min: 18000,
    max: 50000,
    outlook: OUTLOOK.moderate,
    riasec: 'IRC',
  },
  {
    title: 'Environmental Scientist',
    description:
      'Assesses environmental impact and advises on remediation and compliance for industry and LGUs. Non-regulated as a profession, though environmental impact work is governed by DENR accreditation.',
    min: 28000,
    max: 85000,
    outlook: OUTLOOK.high,
    riasec: 'IRS',
  },
  {
    title: 'Pollution Control Officer',
    description:
      'Runs a facility’s environmental compliance — effluent and emissions monitoring, waste manifests and the self-monitoring reports DENR requires. The role is mandatory for covered establishments and requires DENR-EMB accreditation as a PCO on top of the degree.',
    min: 22000,
    max: 65000,
    outlook: OUTLOOK.high,
    riasec: 'IRC',
  },
  {
    title: 'Farm Operations Manager',
    description:
      'Runs the production side of a commercial farm or aquaculture operation — cropping and stocking plans, labour, inputs, machinery and yield. Non-regulated, though signing off as a professional agriculturist requires the PRC licence.',
    min: 20000,
    max: 60000,
    outlook: OUTLOOK.moderate,
    riasec: 'RES',
  },
  {
    title: 'Agricultural Extension Worker',
    description:
      'Brings production technology and training to farmers and fisherfolk for LGU agriculture offices, DA and BFAR. Non-regulated; permanent government posts require Civil Service eligibility.',
    min: 18000,
    max: 45000,
    outlook: OUTLOOK.moderate,
    riasec: 'RSI',
  },
  {
    title: 'Marine Biologist',
    description:
      'Studies marine organisms and ecosystems in field and laboratory settings — a substantial research area across the Visayan and Bohol Sea reef systems. Non-regulated.',
    min: 24000,
    max: 70000,
    outlook: OUTLOOK.moderate,
    riasec: 'IRA',
  },
  {
    title: 'Laboratory Research Associate',
    description:
      'Runs experiments, sample preparation and instrumentation in academic and industrial laboratories. Non-regulated at associate level.',
    min: 20000,
    max: 65000,
    outlook: OUTLOOK.moderate,
    riasec: 'ICR',
  },

  // Communication and the arts
  {
    title: 'Multimedia Artist',
    description:
      'Produces animation, motion graphics and digital media for studios and agencies. Non-regulated; hired on portfolio.',
    min: 20000,
    max: 80000,
    outlook: OUTLOOK.high,
    riasec: 'AIR',
  },
  {
    title: 'Graphic Designer',
    description:
      'Designs visual communication across print and digital media. Non-regulated; hired on portfolio.',
    min: 18000,
    max: 70000,
    outlook: OUTLOOK.moderate,
    riasec: 'ARE',
  },
  {
    title: 'Communications Officer',
    description:
      'Runs corporate and public communications — media relations, content and internal communication. Non-regulated.',
    min: 22000,
    max: 80000,
    outlook: OUTLOOK.moderate,
    riasec: 'AES',
  },
  {
    title: 'Content Writer and Editor',
    description:
      'Writes and edits copy for publications, marketing teams, agencies and technical documentation. Non-regulated; hired on portfolio.',
    min: 18000,
    max: 65000,
    outlook: OUTLOOK.moderate,
    riasec: 'AIC',
  },
  {
    title: 'Journalist',
    description:
      'Reports, writes and produces news for broadcast, print and digital outlets. Non-regulated.',
    min: 18000,
    max: 70000,
    outlook: OUTLOOK.moderate,
    riasec: 'AIS',
  },
  {
    title: 'Lawyer',
    description:
      'Advises clients, drafts instruments and represents parties before the courts and quasi-judicial agencies. Entered through the Juris Doctor, which is a graduate-entry degree, and admission to practice requires passing the Philippine Bar Examination and being admitted to the Roll of Attorneys — the Bar is administered by the Supreme Court, not the PRC.',
    min: 40000,
    max: 180000,
    outlook: OUTLOOK.moderate,
    riasec: 'EIS',
  },
  {
    title: 'Policy Research Analyst',
    description:
      'Researches and drafts policy positions, legislative briefs and programme evaluations for LGUs, national agencies, legislators and NGOs. Non-regulated; permanent government posts require Civil Service eligibility.',
    min: 25000,
    max: 75000,
    outlook: OUTLOOK.moderate,
    riasec: 'IES',
  },
  {
    title: 'Legal Researcher',
    description:
      'Researches jurisprudence and statutes, drafts pleadings and memoranda and manages case records for law firms, courts and corporate legal units. Non-regulated and open before admission to the Bar — it is the common working role for a law student or an unadmitted graduate.',
    min: 20000,
    max: 55000,
    outlook: OUTLOOK.moderate,
    riasec: 'ICE',
  },
  {
    title: 'Security Operations Manager',
    description:
      'Runs guard force operations, access control, investigations and loss prevention for an establishment or a security agency. Governed by RA 11917: agency operators and security professionals require PNP-SOSIA licensing.',
    min: 20000,
    max: 65000,
    outlook: OUTLOOK.moderate,
    riasec: 'ERC',
  },
  {
    title: 'Fire Officer',
    description:
      'Fire suppression, rescue and fire safety inspection with the Bureau of Fire Protection. Entry is by BFP appointment under RA 9263 and requires either a relevant baccalaureate or a PRC/CSC eligibility, plus the BFP’s own recruitment and training process.',
    min: 25000,
    max: 50000,
    outlook: OUTLOOK.moderate,
    riasec: 'RSE',
  },
  {
    title: 'Public Administration Officer',
    description:
      'Works in policy, legislative research and programme administration in national agencies and LGUs. Non-regulated, though career service eligibility (CSC) applies to permanent government appointments.',
    min: 25000,
    max: 90000,
    outlook: OUTLOOK.moderate,
    riasec: 'ESC',
  },

  // --- The expanded source document's finer-grained pathways -------------------------------
  //
  // The first document mapped one or two destinations per programme; the expanded one maps
  // roughly 2.7, and the difference is mostly *specialisation within a licence* — a medical
  // technologist who works blood banking rather than general diagnostics, a civil engineer in
  // geotechnical rather than structural work. Those are the roles a student has actually heard
  // of and is choosing between, so they are modelled as distinct careers rather than collapsed
  // into the generic licence title.
  //
  // The CONDITIONAL ones (Chief Financial Officer, Ship Captain, Clinical Psychologist, Nurse
  // Administrator, Enterprise Systems Architect, Urban and Regional Planner) are included
  // despite not being entry-level, because they are the destination a student is choosing the
  // course *for*. Each description states plainly what stands between graduation and the role,
  // which is the same rule the regulated careers above follow.

  // Accountancy and finance
  {
    title: 'Tax Advisory Specialist',
    description:
      'Advises on corporate taxation, tax filing and BIR compliance for consultancies and corporate tax units. Requires the same CPA licence as external audit under RA 9298 — a BS Accountancy degree, the CPALE, and PRC registration.',
    min: 30000,
    max: 120000,
    outlook: OUTLOOK.high,
    riasec: 'CIS',
  },
  {
    title: 'Chief Financial Officer',
    description:
      'Owns capital structure, enterprise risk and strategic finance for a company. Not an entry-level role: normally a CPA licence plus roughly eight years of progressive finance experience.',
    min: 90000,
    max: 400000,
    outlook: OUTLOOK.moderate,
    riasec: 'ECI',
  },
  {
    title: 'Business Development Specialist',
    description:
      'Builds partnerships, market research and growth plans for corporate strategy units and startups. Non-regulated.',
    min: 28000,
    max: 110000,
    outlook: OUTLOOK.high,
    riasec: 'ESI',
  },

  // Computing
  {
    title: 'AI/Machine Learning Engineer',
    description:
      'Builds and deploys deep learning, computer vision and natural language systems for R&D labs and technology startups. Non-regulated; TensorFlow and PyTorch certifications are the usual signal.',
    min: 50000,
    max: 180000,
    outlook: OUTLOOK.emerging,
    riasec: 'IRC',
  },
  {
    title: 'Enterprise Systems Architect',
    description:
      'Designs system scalability, cloud infrastructure and API strategy across an organisation. Not an entry-level role: normally five or more years of software development first. Non-regulated.',
    min: 70000,
    max: 220000,
    outlook: OUTLOOK.moderate,
    riasec: 'IEC',
  },

  // Built environment
  {
    title: 'Urban and Regional Planner',
    description:
      'Handles spatial analysis, zoning governance and environmental impact assessment for LGU planning offices and NEDA. Regulated under RA 10587 — requires postgraduate planning study and the PRC Environmental Planner licence, on top of an architecture or engineering degree.',
    min: 40000,
    max: 130000,
    outlook: OUTLOOK.moderate,
    riasec: 'IES',
  },
  {
    title: 'BIM Specialist',
    description:
      'Produces 3D structural models, parametric design and clash analysis for engineering and design consultancies. Non-regulated; Autodesk Revit certification is the usual credential.',
    min: 30000,
    max: 100000,
    outlook: OUTLOOK.high,
    riasec: 'RIA',
  },
  {
    title: 'CAD Design Technician',
    description:
      'Produces 2D and 3D computer-aided drafting, blueprint reading and rendering for construction firms and architectural studios. Non-regulated; AutoCAD or SolidWorks certification and a TESDA National Certificate are the usual credentials.',
    min: 18000,
    max: 60000,
    outlook: OUTLOOK.moderate,
    riasec: 'RCA',
  },
  {
    title: 'Geotechnical Engineer',
    description:
      'Works on soil mechanics, slope stability, foundation design and drilling logs for foundation engineering consultancies. Regulated under RA 544 — requires the PRC Civil Engineering Licensure Examination.',
    min: 32000,
    max: 120000,
    outlook: OUTLOOK.moderate,
    riasec: 'RIC',
  },
  {
    title: 'HVAC Design Engineer',
    description:
      'Designs heating and ventilation systems, psychrometric calculation and duct sizing for MEP consultancies and construction. Regulated under RA 8495 — requires the PRC Mechanical Engineer Licensure Examination.',
    min: 32000,
    max: 120000,
    outlook: OUTLOOK.high,
    riasec: 'RIE',
  },
  {
    title: 'Power Plant Engineer',
    description:
      'Runs turbine maintenance, boiler operation and thermal efficiency monitoring at power generation facilities and utilities. Requires a PRC mechanical or electrical engineering licence depending on the plant systems supervised.',
    min: 35000,
    max: 130000,
    outlook: OUTLOOK.moderate,
    riasec: 'RCI',
  },

  // Health specialisations
  {
    title: 'Public Health Nurse',
    description:
      'Runs community health assessment, immunisation programmes and health education for the DOH and rural health units. Requires the same RN licence as hospital nursing under RA 9173 — the Nurse Licensure Examination and PRC registration.',
    min: 22000,
    max: 60000,
    outlook: OUTLOOK.high,
    riasec: 'SIC',
  },
  {
    title: 'Nurse Administrator',
    description:
      'Manages wards, healthcare quality assurance and nursing staff governance. Not an entry-level role: an RN licence plus a Master of Science in Nursing is the normal requirement.',
    min: 45000,
    max: 140000,
    outlook: OUTLOOK.moderate,
    riasec: 'SEC',
  },
  {
    title: 'Clinical Psychologist',
    description:
      'Carries out psychological diagnosis, psychotherapy and clinical assessment. Regulated under RA 10029 and **not** reachable on a bachelor’s degree alone: it requires a Master’s degree in psychology and the Psychologist Licensure Examination, which is a different examination from the Psychometrician one.',
    min: 40000,
    max: 150000,
    outlook: OUTLOOK.moderate,
    riasec: 'ISA',
  },

  // Maritime — credentialled by MARINA under the STCW Convention, not by the PRC
  {
    title: 'Deck Officer',
    description:
      'Stands navigation watch and manages cargo operations on commercial vessels. Credentialled under the STCW Convention and RA 10635 by MARINA, not the PRC: a BS Marine Transportation degree, twelve months of approved seagoing service and assessment, then a Certificate of Competency as Officer in Charge of a Navigational Watch.',
    min: 60000,
    max: 250000,
    outlook: OUTLOOK.high,
    riasec: 'RCI',
  },
  {
    title: 'Marine Surveyor',
    description:
      'Inspects hulls, evaluates cargo damage and audits maritime safety compliance for classification societies and cargo inspectors. Requires MARINA certification and prior sea experience.',
    min: 40000,
    max: 140000,
    outlook: OUTLOOK.moderate,
    riasec: 'RCE',
  },
  {
    title: 'Port Operations Supervisor',
    description:
      'Coordinates vessel berthing, container terminal operations and port safety for port authorities and terminal operators. Non-regulated; port safety certification is optional.',
    min: 30000,
    max: 100000,
    outlook: OUTLOOK.high,
    riasec: 'ECR',
  },
  {
    title: 'Ship Captain',
    description:
      'Commands a vessel, its safety management and maritime law compliance. The top of the deck career, not an entry point: a Master Mariner licence built on roughly ten years of sea time.',
    min: 150000,
    max: 500000,
    outlook: OUTLOOK.moderate,
    riasec: 'REC',
  },

  // Law enforcement and corrections
  {
    title: 'Police Officer',
    description:
      'Carries out criminal investigation, patrol operations and arrest procedures in the Philippine National Police. Requires the PRC Criminologist Licensure Examination under RA 11131 *and* separate PNP appointment eligibility — passing the board alone does not confer a police appointment.',
    min: 29000,
    max: 75000,
    outlook: OUTLOOK.high,
    riasec: 'RSE',
  },
  {
    title: 'Correctional Officer',
    description:
      'Handles inmate custody, prison security management and rehabilitation programmes for the Bureau of Corrections and BJMP. Requires the PRC Criminologist Licensure Examination under RA 11131.',
    min: 29000,
    max: 65000,
    outlook: OUTLOOK.moderate,
    riasec: 'RSC',
  },

  // Education and coastal resources
  {
    title: 'Curriculum Developer',
    description:
      'Designs instruction, maps learning outcomes and edits textbooks for educational publishers and EdTech firms. Non-regulated, though a teaching licence and a Master of Arts in Education are common.',
    min: 25000,
    max: 85000,
    outlook: OUTLOOK.moderate,
    riasec: 'AIS',
  },
  {
    title: 'Aquatic Resource Specialist',
    description:
      'Works on coastal resource management, fish stock assessment and biodiversity protection for coastal LGUs and marine NGOs. Requires the PRC Fisheries Technologist licence under RA 8550 as amended.',
    min: 24000,
    max: 75000,
    outlook: OUTLOOK.moderate,
    riasec: 'IRS',
  },
];

// --- 4. canonical programmes ---------------------------------------------------------------------
//
// The programme "as a thing in the world" — what makes "which colleges offer this?" a join rather
// than a string match (migration 0018).
//
// `strand` is `recommended_strand` and is a **claim**, not a missing value: NULL means "this
// programme has no strand requirement", which §27 scores as a full 100. It is set on the three
// programmes where entry genuinely does not assume a senior-high track.

const A = 'Academic';
const T = 'Technical-Professional';

const PROGRAMS = [
  // Computing — four entries, deliberately. These are four different careers and must not be
  // normalised together. Talibon Polytechnic's "BS Information System" is BSIS under its own
  // singular title; the offering row keeps what the college calls it.
  { code: 'BSCS', name: 'BS Computer Science', strand: A, description: 'Computational theory, algorithm design and software architecture.' },
  { code: 'BSIT', name: 'BS Information Technology', strand: A, description: 'Systems administration, network infrastructure and web application deployment.' },
  { code: 'BSIS', name: 'BS Information Systems', strand: A, description: 'Business process integration and enterprise software systems.' },
  { code: 'BSCPE', name: 'BS Computer Engineering', strand: A, description: 'Hardware-software interfaces, embedded circuit design and computer architecture.' },

  // Engineering — the licensure track. Offered in Bohol only at BISU Main, UB and HNU.
  { code: 'BSCE', name: 'BS Civil Engineering', strand: A, description: 'Structural calculation, reinforced concrete design, hydraulics and construction cost estimation.' },
  { code: 'BSME', name: 'BS Mechanical Engineering', strand: A, description: 'Thermodynamics, machine design and manufacturing systems.' },
  { code: 'BSEE', name: 'BS Electrical Engineering', strand: A, description: 'Power systems, electrical machines and building electrical design.' },
  { code: 'BSABE', name: 'BS Agricultural and Biosystems Engineering', strand: A, description: 'Farm machinery, irrigation and land-and-water resources engineering, and agricultural processing plant.' },
  { code: 'BSARCH', name: 'BS Architecture', strand: A, description: 'Architectural design, building code compliance, AutoCAD and Revit (BIM) practice.' },
  { code: 'BSINDDES', name: 'BS Industrial Design', strand: A, description: 'Product design, materials and manufacture, prototyping and human factors. Distinct from interior design and from industrial engineering: the object is the artefact.' },

  // Maritime. Both are MARINA/STCW credential paths under RA 10635, not PRC ones — the licence is
  // a Certificate of Competency earned after approved sea service, which no degree confers.
  // Institutions title these inconsistently ("Marine" at BIT, "Maritime" at PMI and Cristal); the
  // canonical entries are one each and the offering rows carry the institution's own wording.
  { code: 'BSMARE', name: 'BS Marine Engineering', strand: T, description: 'Shipboard machinery, propulsion and marine systems, with supervised sea service.' },
  { code: 'BSMARTRANS', name: 'BS Marine Transportation', strand: T, description: 'Ocean navigation, watchkeeping, passage planning, cargo operations and collision regulations.' },

  // Industrial and technology programmes — the BISU Balilihan and Calape tier. These are
  // technologist tracks, not the engineering licensure tracks above, and they are kept separate
  // for exactly the reason BSA is kept separate from BSMA: a BS Industrial Technology graduate is
  // not eligible for the PRC electrical or mechanical engineering examinations, and collapsing the
  // two would tell a student the opposite.
  { code: 'BSINDTECH', name: 'BS Industrial Technology', strand: T, description: 'Applied manufacturing, machine shop, welding and industrial maintenance practice.' },
  { code: 'BSELECTECH', name: 'BS Electrical Technology', strand: T, description: 'Electrical installation, motor control and building wiring to Philippine Electrical Code practice.' },
  { code: 'BSELXTECH', name: 'BS Electronics Technology', strand: T, description: 'Electronic servicing, instrumentation and communications equipment maintenance.' },

  // Health sciences
  { code: 'BSN', name: 'BS Nursing', strand: A, description: 'Clinical patient care, IV therapy, bedside assessment and emergency response.' },
  { code: 'BSPHARM', name: 'BS Pharmacy', strand: A, description: 'Pharmaceutical science, dispensing and pharmacy practice.' },
  { code: 'BSPT', name: 'BS Physical Therapy', strand: A, description: 'Rehabilitation of movement and physical function.' },
  { code: 'BSMID', name: 'BS Midwifery', strand: A, description: 'Prenatal, delivery and postnatal care, newborn care and maternal health in community and facility settings.' },

  // Accountancy and business — BSA is kept separate from BS AIS because only BSA graduates may sit
  // the CPALE under RA 9298.
  { code: 'BSA', name: 'BS Accountancy', strand: A, description: 'Financial auditing, PFRS/IAS standards, internal controls and tax compliance. The only accounting track whose graduates may sit the CPA Licensure Examination.' },
  { code: 'BSAIS', name: 'BS Accounting Information Systems', strand: A, description: 'Accounting systems, controls and business process automation. A non-licensure track.' },
  { code: 'BSBA', name: 'BS Business Administration', strand: A, description: 'Management, marketing, finance and operations.' },
  { code: 'BSENTREP', name: 'BS Entrepreneurship', strand: A, description: 'Venture creation, business planning and small enterprise management.' },
  { code: 'BSOA', name: 'BS Office Administration', strand: T, description: 'Office systems, records management, business correspondence and administrative support practice.' },
  { code: 'BSHM', name: 'BS Hospitality Management', strand: T, description: 'Hotel, restaurant and events operations.' },
  { code: 'BSTM', name: 'BS Tourism Management', strand: T, description: 'Destination management, travel operations and visitor services.' },

  // Education
  { code: 'BEED', name: 'Bachelor of Elementary Education', strand: A, description: 'Elementary teaching, curriculum and assessment.' },
  { code: 'BSED', name: 'Bachelor of Secondary Education', strand: A, description: 'Secondary teaching with a subject major.' },
  { code: 'BPED', name: 'Bachelor of Physical Education', strand: A, description: 'Physical education pedagogy, sports science and athletic programme management.' },

  // Social sciences, law and law enforcement
  { code: 'BSPSY', name: 'BS Psychology', strand: A, description: 'Behavioural science, psychological assessment and research methods.' },
  { code: 'BSCRIM', name: 'BS Criminology', strand: A, description: 'Crime scene investigation, Philippine criminal law, criminalistics and forensic ballistics.' },
  { code: 'ABPOLSCI', name: 'AB Political Science', strand: null, description: 'Government, law and political theory.' },
  { code: 'ABENG', name: 'AB English Language', strand: null, description: 'English linguistics, literature and professional writing.' },
  { code: 'BPA', name: 'Bachelor of Public Administration', strand: null, description: 'Public sector management, local governance and public policy.' },
  // The only graduate-entry programme in this catalog. It is listed because University of Bohol
  // genuinely offers it, and its description says plainly that it is not a first degree — a senior
  // high school student reading "Juris Doctor" on a recommendations screen otherwise learns the
  // wrong thing about what they can enrol in next year.
  { code: 'JD', name: 'Juris Doctor', strand: null, description: 'The professional law degree. Entered after a bachelor degree, not from senior high school, and admission to practice requires passing the Philippine Bar Examination.' },

  // Sciences, environment, marine and agriculture
  { code: 'BSMARBIO', name: 'BS Marine Biology', strand: A, description: 'Marine organisms, reef ecosystems and coastal resource science.' },
  { code: 'BSENVSCI', name: 'BS Environmental Science', strand: A, description: 'Environmental systems, impact assessment and management.' },
  { code: 'BSFISH', name: 'BS Fisheries', strand: T, description: 'Aquaculture, capture fisheries and aquatic resource management.' },
  { code: 'BSAGRI', name: 'BS Agriculture', strand: T, description: 'Crop science, animal science and farm management.' },
  { code: 'BSFOR', name: 'BS Forestry', strand: T, description: 'Silviculture, forest resource management, watershed protection and agroforestry.' },
  { code: 'BSFT', name: 'BS Food Technology', strand: T, description: 'Food processing, preservation, product development and food safety systems.' },
];

// --- 5. offerings ---------------------------------------------------------------------------------
//
// Which of the 22 campuses offers which canonical programme, transcribed from the numbered lists
// in `colleges.md`. A bare code means the campus uses the canonical title;
// `'BSMARTRANS as BSMT/BS Maritime Transportation'` records a campus whose own title differs —
// `programs.code`/`programs.name` keep what the institution calls it, `program_catalog_id` links it
// to what it *is*. That split is what lets a student see "BS Maritime Transportation at PMI" and
// still find every other Bohol campus teaching the same curriculum under a different name.
//
// Two titles in `colleges.md` are typos and are normalised rather than reproduced — see the
// comments on BISU Calape and Tagbilaran City College below.

const OFFERINGS = {
  // --- Bohol Island State University ---------------------------------------------------------
  BISU_MAIN: [
    'BSCE', 'BSME', 'BSEE', 'BSCPE',
    'BSARCH', 'BSINDDES',
    'BSIT', 'BSENVSCI',
    'BSENTREP', 'BSOA',
    'BEED', 'BSED', 'BPED',
  ],
  BISU_BALILIHAN: [
    'BSIT', 'BSCS',
    'BSINDTECH', 'BSELECTECH', 'BSELXTECH',
    'BSCRIM',
  ],
  BISU_BILAR: [
    'BSAGRI', 'BSFOR', 'BSABE',
    'BSCS',
    'BEED', 'BSED',
  ],
  // `colleges.md` prints "BS Computes Science" here. It is a typo for BS Computer Science, not a
  // programme, and it is normalised rather than reproduced — an offering row titled "BS Computes
  // Science" would be a search result no student could match and a canonical programme of one.
  BISU_CALAPE: [
    'BSCS',
    'BSINDTECH', 'BSFISH', 'BSFT', 'BSMID',
    'BEED', 'BSED',
  ],
  BISU_CLARIN: [
    'BSENVSCI', 'BSHM', 'BSCS',
    'BEED', 'BSED',
  ],
  BISU_CANDIJAY: [
    'BSMARBIO', 'BSFISH', 'BSCS',
    'BEED', 'BSED',
  ],

  // --- The Tagbilaran private universities ---------------------------------------------------
  UB: [
    'BSA', 'BSBA',
    'BSIT', 'BSCS',
    'BSCE', 'BSME', 'BSEE',
    'BSCRIM',
    'BSPHARM', 'BSPT',
    'BSHM', 'BSTM',
    'ABPOLSCI', 'BSPSY',
    'BEED', 'BSED',
    'JD',
  ],
  HNU: [
    'BSN', 'BSA', 'BSBA',
    'BSIT', 'BSCPE', 'BSCE',
    'BSHM', 'BSTM',
    'BSPSY',
    'BEED', 'BSED',
  ],

  // --- BIT International College -------------------------------------------------------------
  BIT_TAGBILARAN: [
    'BSIT', 'BSCS',
    'BSHM', 'BSBA',
    'BSCRIM',
    'BSMARTRANS',
  ],
  BIT_CARMEN: ['BSIT', 'BSHM', 'BSCRIM'],
  BIT_JAGNA: ['BSIT', 'BSBA', 'BSHM'],
  BIT_TALIBON: ['BSIT', 'BSHM', 'BSCRIM'],

  // --- The provincial private colleges -------------------------------------------------------
  MATERDEI: [
    'BSN', 'BSMID',
    'BSBA', 'BSIT',
    'BSHM', 'BSTM',
    'BSCRIM',
    'BEED', 'BSED',
  ],
  BNSC: [
    'BSCRIM', 'BSBA', 'BSHM',
    'BEED', 'BSED',
  ],
  // PMI and Cristal Panglao title the maritime pair "Maritime" where BIT titles it "Marine". The
  // curriculum and the MARINA credential are the same, so the canonical codes are the same and the
  // offering rows keep each institution's own wording — that is what `programs.code`/`name` are for.
  PMI: [
    'BSMARTRANS as BSMT/BS Maritime Transportation',
    'BSMARE as BSMarE/BS Maritime Engineering',
  ],
  CRISTAL_TAGBILARAN: ['BSIT', 'BSBA', 'BSTM'],
  CRISTAL_PANGLAO: [
    'BSIT', 'BSTM',
    'BSMARTRANS as BSMT/BS Maritime Transportation',
    'BSMARE as BSMarE/BS Maritime Engineering',
  ],

  // --- The LUC tier ---------------------------------------------------------------------------
  BUENAVISTA_CC: ['BSBA', 'BSIT', 'BSCRIM', 'BEED'],
  TRINIDAD_MC: ['BSBA', 'BPA', 'BEED'],
  BATUAN_COLLEGE: ['BEED', 'BSED', 'BSBA'],
  TALIBON_POLY: [
    'BSAGRI',
    'BSAIS as BSAIS/BS Accounting Information System',
    'BSIS as BSIS/BS Information System',
    'BSCRIM',
    'ABPOLSCI as ABPolSci/Bachelor of Arts in Political Science',
    'ABENG as ABEng/Bachelor of Arts in English Language',
  ],
  // `colleges.md` prints "BS Entrepreurship". Normalised, for the same reason as BISU Calape above.
  TAGBILARAN_CC: ['BSENTREP', 'BSHM'],
};

// --- 6. programme → career mapping ----------------------------------------------------------------
//
// **The rows §27 actually ranks programmes on.** A programme's RIASEC compatibility is the average
// of its linked careers' Holland codes; an unmapped programme takes a neutral 50 and becomes
// indistinguishable from every other unmapped one. Every canonical programme below is mapped, and
// the emitter fails the build if one is not.
//
// The first career listed is the programme's DIRECT pathway in the PDF's taxonomy. What follows is
// RELATED or licensed-CONDITIONAL. BROAD roles are deliberately absent — see the header.

const MAPPINGS = {
  BSCS: ['Software Developer', 'Data Scientist', 'Cybersecurity Analyst', 'AI/Machine Learning Engineer', 'Cloud Infrastructure Engineer', 'Enterprise Systems Architect', 'Quality Assurance Engineer'],
  BSIT: ['Software Developer', 'Systems Administrator', 'Network Engineer', 'IT Support Specialist', 'Database Administrator', 'Cybersecurity Analyst', 'Cloud Infrastructure Engineer'],
  BSIS: ['Business Systems Analyst', 'Database Administrator', 'Data Analyst', 'Software Developer', 'Supply Chain Analyst'],
  BSCPE: ['Computer Engineer', 'Network Engineer', 'Software Developer', 'Systems Administrator', 'Embedded Systems Engineer'],

  BSCE: ['Civil Engineer', 'Geotechnical Engineer', 'Construction Project Manager', 'Quantity Surveyor', 'BIM Specialist', 'Occupational Health and Safety Officer'],
  BSME: ['Mechanical Engineer', 'HVAC Design Engineer', 'Power Plant Engineer', 'Construction Project Manager', 'Maintenance Engineer', 'Occupational Health and Safety Officer'],
  BSEE: ['Electrical Engineer', 'Power Plant Engineer', 'Construction Project Manager', 'Maintenance Engineer', 'Renewable Energy Specialist'],
  BSABE: ['Agricultural and Biosystems Engineer', 'Agriculturist', 'Environmental Scientist', 'Food Technologist', 'Farm Operations Manager'],
  BSARCH: ['Architect', 'BIM Specialist', 'Urban and Regional Planner', 'Construction Project Manager', 'Interior Designer', 'Quantity Surveyor'],
  BSINDDES: ['Industrial Designer', 'CAD Design Technician', 'Graphic Designer', 'Multimedia Artist', 'UI/UX Designer'],

  BSMARE: ['Marine Engineer', 'Power Plant Engineer', 'Port Operations Supervisor', 'Mechanical Engineer', 'Maintenance Engineer'],
  BSMARTRANS: ['Deck Officer', 'Marine Surveyor', 'Port Operations Supervisor', 'Ship Captain'],

  // The technologist tracks map to technician and supervisory roles, never to the licensed
  // engineering titles above. That boundary is the whole reason they are separate canonical
  // programmes, and a mapping that crossed it would quietly promise a PRC licence the curriculum
  // does not lead to.
  BSINDTECH: ['Industrial Technologist', 'CAD Design Technician', 'Quality Assurance Engineer', 'Operations Manager', 'Occupational Health and Safety Officer', 'Instrumentation Technician'],
  BSELECTECH: ['Electrical Technician', 'Industrial Technologist', 'CAD Design Technician', 'Instrumentation Technician', 'Occupational Health and Safety Officer'],
  BSELXTECH: ['Electronics Technician', 'Industrial Technologist', 'IT Support Specialist', 'Instrumentation Technician', 'Embedded Systems Engineer'],

  BSN: ['Registered Nurse', 'Public Health Nurse', 'Clinical Researcher', 'Nurse Administrator', 'Public Health Officer', 'Occupational Health and Safety Officer', 'Medical Sales Representative'],
  BSPHARM: ['Pharmacist', 'Clinical Researcher', 'Laboratory Research Associate', 'Regulatory Affairs Specialist', 'Medical Sales Representative'],
  BSPT: ['Physical Therapist', 'Public Health Officer', 'Sports Rehabilitation Specialist'],
  BSMID: ['Midwife', 'Public Health Officer', 'Public Health Nurse'],

  BSA: ['Certified Public Accountant', 'Tax Advisory Specialist', 'Financial Analyst', 'Internal Auditor', 'Chief Financial Officer'],
  BSAIS: ['Business Systems Analyst', 'Internal Auditor', 'Data Analyst', 'Financial Analyst'],
  BSBA: ['Marketing Specialist', 'Operations Manager', 'Business Development Specialist', 'Human Resources Specialist', 'Bank Operations Officer', 'Financial Analyst', 'Events Manager', 'Executive Assistant'],
  BSENTREP: ['Entrepreneur', 'Business Development Specialist', 'Marketing Specialist', 'Operations Manager'],
  BSOA: ['Office Administrator', 'Human Resources Specialist', 'Operations Manager', 'Executive Assistant'],
  BSHM: ['Hotel Operations Manager', 'Operations Manager', 'Entrepreneur', 'Events Manager', 'Food and Beverage Supervisor', 'Tour Operations Manager'],
  BSTM: ['Tourism Officer', 'Hotel Operations Manager', 'Marketing Specialist', 'Tour Operations Manager', 'Events Manager'],

  BEED: ['Elementary School Teacher', 'Curriculum Developer', 'Guidance Counselor', 'School Administrator'],
  BSED: ['Secondary School Teacher', 'Curriculum Developer', 'Guidance Counselor', 'School Administrator'],
  BPED: ['Physical Education Teacher', 'Secondary School Teacher', 'Elementary School Teacher', 'Athletic Coach', 'Sports Rehabilitation Specialist', 'School Administrator'],

  BSPSY: ['Psychometrician', 'Human Resources Specialist', 'Clinical Psychologist', 'Guidance Counselor', 'Clinical Researcher'],
  BSCRIM: ['Registered Criminologist', 'Police Officer', 'Crime Scene Investigator', 'Correctional Officer', 'Public Administration Officer', 'Security Operations Manager', 'Fire Officer', 'Legal Researcher'],
  ABPOLSCI: ['Public Administration Officer', 'Communications Officer', 'Journalist', 'Lawyer', 'Policy Research Analyst', 'Legal Researcher'],
  ABENG: ['Communications Officer', 'Journalist', 'Secondary School Teacher', 'Curriculum Developer', 'Content Writer and Editor'],
  BPA: ['Public Administration Officer', 'Operations Manager', 'Human Resources Specialist', 'Policy Research Analyst', 'Security Operations Manager'],
  JD: ['Lawyer', 'Public Administration Officer', 'Internal Auditor', 'Policy Research Analyst', 'Legal Researcher'],

  BSMARBIO: ['Marine Biologist', 'Aquatic Resource Specialist', 'Environmental Scientist', 'Fisheries Technologist', 'Laboratory Research Associate'],
  BSENVSCI: ['Environmental Scientist', 'Public Health Officer', 'Laboratory Research Associate', 'Pollution Control Officer', 'Renewable Energy Specialist'],
  BSFISH: ['Fisheries Technologist', 'Aquatic Resource Specialist', 'Marine Biologist', 'Agriculturist', 'Farm Operations Manager', 'Agricultural Extension Worker'],
  BSAGRI: ['Agriculturist', 'Environmental Scientist', 'Entrepreneur', 'Farm Operations Manager', 'Agricultural Extension Worker', 'Pollution Control Officer'],
  BSFOR: ['Forester', 'Environmental Scientist', 'Agriculturist', 'Pollution Control Officer', 'Agricultural Extension Worker'],
  BSFT: ['Food Technologist', 'Laboratory Research Associate', 'Quality Assurance Engineer', 'Entrepreneur', 'Regulatory Affairs Specialist', 'Food and Beverage Supervisor'],
};

// --- emitter ---------------------------------------------------------------------------------------

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/**
 * Address-hierarchy lookups, resolved by **name scoped to the parent chain** rather than by the
 * derived id.
 *
 * The inserts above are `INSERT OR IGNORE` against partial unique indexes on name, so if an admin
 * has already created "Cebu City" through the address screens, the row this seed derived an id for
 * is never written — and a college pointing at that id would reference nothing. Looking the id up
 * instead finds whichever row actually exists.
 *
 * The chain matters as much as the name. `provinces_region_name_live_unique` is (region_id, name),
 * so a second "Cebu" under some other region is legal, and a bare `WHERE name = 'Cebu'` would
 * return an arbitrary one of the two. Each lookup therefore walks up to the region.
 */
const regionLookup = () =>
  `(SELECT id FROM regions WHERE name = ${q(REGION.name)} COLLATE NOCASE AND deleted_at IS NULL)`;

const provinceLookup = (province) =>
  `(SELECT p.id FROM provinces p JOIN regions r ON r.id = p.region_id` +
  ` WHERE p.name = ${q(province)} COLLATE NOCASE AND p.deleted_at IS NULL` +
  ` AND r.name = ${q(REGION.name)} COLLATE NOCASE AND r.deleted_at IS NULL)`;

const townLookup = (town, province) =>
  `(SELECT t.id FROM towns t JOIN provinces p ON p.id = t.province_id JOIN regions r ON r.id = p.region_id` +
  ` WHERE t.name = ${q(town)} COLLATE NOCASE AND t.deleted_at IS NULL` +
  ` AND p.name = ${q(province)} COLLATE NOCASE AND p.deleted_at IS NULL` +
  ` AND r.name = ${q(REGION.name)} COLLATE NOCASE AND r.deleted_at IS NULL)`;

/** A SQL string literal, or NULL. */
function q(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

const problems = [];
function require_(condition, message) {
  if (!condition) problems.push(message);
}

// Cross-reference checks. These are the reason this generator exists: each one is a class of
// silent data bug that would otherwise ship as a wrong screen.

const careerByTitle = new Map(CAREERS.map((c) => [c.title, c]));
require_(careerByTitle.size === CAREERS.length, 'Two careers share a title.');

const programByCode = new Map(PROGRAMS.map((p) => [p.code, p]));
require_(programByCode.size === PROGRAMS.length, 'Two canonical programmes share a code.');

const collegeByKey = new Map(COLLEGES.map((c) => [c.key, c]));
const townByName = new Map(TOWNS.map((t) => [t.name, t]));
const provinceByName = new Map(PROVINCES.map((p) => [p.name, p]));

for (const career of CAREERS) {
  const letters = career.riasec.split('');
  require_(
    /^[RIASEC]{1,3}$/.test(career.riasec) && new Set(letters).size === letters.length,
    `${career.title}: "${career.riasec}" is not 1-3 distinct RIASEC letters.`,
  );
  require_(career.min < career.max, `${career.title}: salary_min must be below salary_max.`);
  require_(career.title.length <= 150, `${career.title}: title exceeds the 150-character limit.`);
}

/**
 * No more than four careers may share a Holland code.
 *
 * A shared code is not a bug — nine engineering roles really are Realistic/Investigative — but
 * §27's career composite is 60% RIASEC compatibility, so careers with identical codes score
 * *identically* and their order in a student's top ten is decided by the tie-break rather than by
 * fit. The first draft of this catalog had RIC nine times and IRC eight, which meant a Realistic
 * student's list was an arbitrary slice of one cluster and a second engineering-minded student
 * saw the same slice.
 *
 * The cap was three, and was raised to **four** when the expanded source document took the
 * catalog past ninety careers. The number itself is not the point — what matters is that no one
 * cluster can fill a top ten on its own, which four cannot. Raising it is the right response to a
 * larger catalog; contorting a career's Holland code to satisfy a counter is not, because §27
 * reads that code positionally and a dishonest one silently mis-ranks every student it reaches.
 */
const MAX_CAREERS_PER_HOLLAND_CODE = 4;

const byHollandCode = new Map();
for (const career of CAREERS) {
  byHollandCode.set(career.riasec, [...(byHollandCode.get(career.riasec) ?? []), career.title]);
}
for (const [code, titles] of byHollandCode) {
  require_(
    titles.length <= MAX_CAREERS_PER_HOLLAND_CODE,
    `${titles.length} careers share the Holland code "${code}" (max ${MAX_CAREERS_PER_HOLLAND_CODE}) — ` +
      `they will tie exactly in every ranking: ${titles.join(', ')}.`,
  );
}

for (const program of PROGRAMS) {
  require_(program.code.length <= 30, `${program.code}: code exceeds the 30-character limit.`);
  require_(program.name.length <= 200, `${program.code}: name exceeds the 200-character limit.`);
  require_(
    program.strand === null || program.strand === A || program.strand === T,
    `${program.code}: "${program.strand}" is not a valid recommended_strand.`,
  );
}

for (const town of TOWNS) {
  require_(provinceByName.has(town.province), `${town.name}: unknown province "${town.province}".`);
}

for (const college of COLLEGES) {
  require_(townByName.has(college.town), `${college.name}: unknown town "${college.town}".`);
  require_(college.name.length <= 200, `${college.name}: name exceeds the 200-character limit.`);
}

/** `'BSMLS as BSMT/BS Medical Technology'` → the canonical code and the institution's own title. */
function parseOffering(entry) {
  const [canonicalCode, override] = entry.split(' as ');
  if (override === undefined) {
    const program = programByCode.get(canonicalCode);
    return { canonicalCode, code: canonicalCode, name: program?.name };
  }
  const separator = override.indexOf('/');
  return {
    canonicalCode,
    code: override.slice(0, separator),
    name: override.slice(separator + 1),
  };
}

const offeredCodes = new Set();
for (const [key, entries] of Object.entries(OFFERINGS)) {
  require_(collegeByKey.has(key), `OFFERINGS has an unknown institution key "${key}".`);
  const seen = new Set();
  for (const entry of entries) {
    const { canonicalCode, code } = parseOffering(entry);
    require_(programByCode.has(canonicalCode), `${key} offers unknown programme "${canonicalCode}".`);
    // `programs.code` is unique within a live college — the Service enforces it, so a seed that
    // violated it would produce a catalog the admin screens then refuse to edit.
    require_(!seen.has(code), `${key} offers "${code}" twice.`);
    seen.add(code);
    offeredCodes.add(canonicalCode);
  }
}

for (const program of PROGRAMS) {
  require_(
    MAPPINGS[program.code] !== undefined && MAPPINGS[program.code].length > 0,
    `${program.code} has no career mapping — §27 would score it a neutral 50.`,
  );
  require_(
    offeredCodes.has(program.code),
    `${program.code} is in the canonical catalog but no institution offers it.`,
  );
}

const mappedCareers = new Set();
for (const [code, titles] of Object.entries(MAPPINGS)) {
  require_(programByCode.has(code), `MAPPINGS has an unknown programme "${code}".`);
  require_(new Set(titles).size === titles.length, `${code} maps the same career twice.`);
  for (const title of titles) {
    require_(careerByTitle.has(title), `${code} maps unknown career "${title}".`);
    mappedCareers.add(title);
  }
}

for (const career of CAREERS) {
  require_(
    mappedCareers.has(career.title),
    `"${career.title}" is mapped to no programme — it would never appear in a ranking.`,
  );
}

if (problems.length > 0) {
  console.error(`build-region7-seed: ${problems.length} problem(s) in the catalog data:\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

// --- rows -------------------------------------------------------------------------------------------

const regionId = id('regions', REGION.name);
const provinceIds = new Map(PROVINCES.map((p) => [p.name, id('provinces', REGION.name, p.name)]));
const townIds = new Map(TOWNS.map((t) => [t.name, id('towns', REGION.name, t.province, t.name)]));
const collegeIds = new Map(COLLEGES.map((c) => [c.key, id('colleges', c.name)]));
const careerIds = new Map(CAREERS.map((c) => [c.title, id('careers', c.title)]));
const catalogIds = new Map(PROGRAMS.map((p) => [p.code, id('program_catalog', p.code)]));

const programRows = [];
for (const [key, entries] of Object.entries(OFFERINGS)) {
  const college = collegeByKey.get(key);
  for (const entry of entries) {
    const offering = parseOffering(entry);
    const canonical = programByCode.get(offering.canonicalCode);
    programRows.push({
      id: id('programs', college.name, offering.code),
      collegeId: collegeIds.get(key),
      catalogId: catalogIds.get(offering.canonicalCode),
      code: offering.code,
      name: offering.name,
      description: canonical.description,
      strand: canonical.strand,
      canonicalCode: offering.canonicalCode,
    });
  }
}

const mapRows = [];
for (const program of programRows) {
  for (const title of MAPPINGS[program.canonicalCode]) {
    mapRows.push({
      id: id('program_careers', program.id, careerIds.get(title)),
      programId: program.id,
      careerId: careerIds.get(title),
    });
  }
}

// A UUIDv5 collision would silently drop a row under INSERT OR IGNORE, so it is checked rather
// than assumed.
const allIds = [
  regionId,
  ...provinceIds.values(),
  ...townIds.values(),
  ...collegeIds.values(),
  ...careerIds.values(),
  ...catalogIds.values(),
  ...programRows.map((p) => p.id),
  ...mapRows.map((m) => m.id),
];
if (new Set(allIds).size !== allIds.length) {
  console.error('build-region7-seed: derived ids collide. Change a natural key.');
  process.exit(1);
}

// --- SQL ---------------------------------------------------------------------------------------------

const out = [];
const w = (line = '') => out.push(line);

/**
 * The per-statement size ceiling this file is emitted under.
 *
 * D1 refuses a single statement over 100 KB with `statement too long: SQLITE_TOOBIG`, and the
 * mapping insert crossed it the moment the expanded source document took the catalog to 877
 * rows. The failure is worth describing precisely, because it is the kind that reaches
 * production: `wrangler d1 execute --file` parses the whole file before running any of it, so
 * the seed does not half-apply — it refuses outright, and a run whose stderr is being discarded
 * looks exactly like a successful one. It was caught here only because the row counts afterwards
 * were still the old ones.
 *
 * 40,000 is deliberately well under the ceiling rather than just beneath it: the longest row is
 * a career with a multi-sentence description, and a future edit that doubles one must not be
 * what discovers the limit again.
 */
const MAX_STATEMENT_CHARS = 40_000;

/**
 * Emit `INSERT OR IGNORE INTO <table> (<columns>) VALUES …;` over `rows`, split into as many
 * statements as the size ceiling requires. Splitting is safe here in a way it would not be for
 * arbitrary SQL: every row is independent, `INSERT OR IGNORE` is idempotent, and the seed's
 * ordering guarantees are between *tables* (parents before children), not within one.
 */
function writeInsert(table, columns, rows) {
  const header = `INSERT OR IGNORE INTO ${table} (${columns}) VALUES`;
  let batch = [];
  let size = 0;

  const flush = () => {
    if (batch.length === 0) return;
    w(header);
    w(batch.join(',\n') + ';');
    w();
    batch = [];
    size = 0;
  };

  for (const row of rows) {
    // `+ 2` for the comma and newline this row will be joined with.
    if (batch.length > 0 && size + row.length + 2 > MAX_STATEMENT_CHARS - header.length) {
      flush();
    }
    batch.push(row);
    size += row.length + 2;
  }

  flush();
}

w(`-- Seed 0005 — the Bohol academic catalog. **Generated file.**`);
w(`--`);
w(`-- Edit \`scripts/build-region7-seed.mjs\` and re-run \`node scripts/build-region7-seed.mjs\`.`);
w(`-- Editing this file by hand works exactly once, until the next regeneration overwrites it, and`);
w(`-- \`npm run seed:region7:check\` fails the build in the meantime.`);
w(`--`);
w(`-- ## What this file does`);
w(`--`);
w(`-- It is a **reset**, not an addition. It replaces whatever catalog is in the database with the`);
w(`-- ${COLLEGES.length} Bohol campuses enumerated in \`colleges.md\`, the source document at the repository root.`);
w(`--`);
w(`-- ## The boundary is Bohol, and that is narrower than it used to be`);
w(`--`);
w(`-- Earlier revisions of this seed covered Region VII as RA 12000 leaves it — Bohol **and Cebu**,`);
w(`-- 16 institutions, Negros Oriental and Siquijor having moved to the Negros Island Region. The`);
w(`-- twelve Cebu institutions (USC, CTU, UP Cebu, USJ-R, Cebu Doctors', PhilSCA, UC, CIT-U, CNU,`);
w(`-- Velez, Benedicto, Lapu-Lapu City College) are **gone from this catalog**, deliberately and on`);
w(`-- instruction: \`colleges.md\` is a Bohol document and the catalog was scoped to match it.`);
w(`--`);
w(`-- That is a real narrowing and it is worth stating plainly, because it is invisible from inside`);
w(`-- the app: a student in Cebu City now gets a recommendations list on which every institution is`);
w(`-- across a ferry. Restoring the Cebu half means restoring those institutions to \`COLLEGES\`,`);
w(`-- \`OFFERINGS\` and \`MAPPINGS\` in the generator — the git history of this file has them.`);
w(`--`);
w(`-- ## Campuses are rows`);
w(`--`);
w(`-- The other structural change. BISU was one row whose description named six campuses, and BIT`);
w(`-- one row naming four. They are now ${COLLEGES.length} rows across ${new Set(COLLEGES.map((c) => c.town)).size} towns, each with its own programme list and`);
w(`-- its own map link, because "which colleges offer BS Fisheries?" should answer "BISU Candijay`);
w(`-- and BISU Calape", not "BISU" — and a student who cannot relocate needs the campus, not the`);
w(`-- institution.`);
w(`--`);
w(`-- ## What it deletes, and what that costs`);
w(`--`);
w(`-- Every college, programme, canonical programme, career and mapping in the database, in foreign`);
w(`-- key order. That reaches further than the catalog: \`recommendations\` cascades from both`);
w(`-- \`careers\` and \`programs\`, and \`recommendation_explanations\` cascades from that — so **every`);
w(`-- student's stored recommendations are removed**, because every one of them points at a career`);
w(`-- or programme that is about to stop existing.`);
w(`--`);
w(`-- That is recoverable and does not lose anything a student authored: assessment attempts,`);
w(`-- results and chat conversations are untouched, and §27 recomputes a ranking from the stored`);
w(`-- result on demand — \`POST /student/recommendations/regenerate\`, the button added by audit C4,`);
w(`-- or its counselor-side equivalent. The first student to open the page after this seed runs`);
w(`-- sees the empty state and a regenerate action, not an error.`);
w(`--`);
w(`-- Deletes are written explicitly and in dependency order rather than left to ON DELETE CASCADE:`);
w(`-- the cascade is correct, but it depends on \`PRAGMA foreign_keys\` being on in whatever executes`);
w(`-- this, and a seed that silently orphans half a schema because a pragma was off is not a risk`);
w(`-- worth taking for four saved lines.`);
w(`--`);
w(`-- ## The one thing this seed cannot reach: the AI knowledge base`);
w(`--`);
w(`-- The AI does not read these tables. It reads a corpus derived from them — one knowledge entry`);
w(`-- per career and per programme, generated by \`syncCatalogKnowledge\` and embedded into Vectorize.`);
w(`-- SQL cannot update that, so **after applying this seed, run the catalog knowledge sync**:`);
w(`-- the "Sync catalog" action on the admin knowledge screen, or`);
w(`-- \`POST /api/v1/admin/knowledge-catalog-sync\`. It also runs nightly at 03:00.`);
w(`--`);
w(`-- Skipping it is not cosmetic and it does not fail loudly. Measured on production 2026-09-05,`);
w(`-- after this seed had been applied but before any sync: **Explain more** cited "BS Chemical`);
w(`-- Engineering at De La Salle University" and "at Mapúa University" — institutions this seed had`);
w(`-- already deleted — and the chat assistant answered "I don't have that information" when a Cebu`);
w(`-- student asked where to study Chemical Engineering, while USC, USJ-R and CIT-U all offered it`);
w(`-- three tables away. The catalog was right and the answers were wrong, because the corpus was`);
w(`-- still describing the catalog this file replaced.`);
w(`--`);
w(`-- ## Idempotent`);
w(`--`);
w(`-- Delete-then-insert, with content-derived UUIDv5 primary keys. Running it twice produces the`);
w(`-- same database as running it once, and the ids are stable across regenerations, so a`);
w(`-- re-seed does not invalidate anything that recorded one.`);
w(`--`);
w(`-- Salary bands and \`typical_riasec_code\` are considered **estimates, not measurements** —`);
w(`-- monthly PHP for the Central Visayas market, Holland codes from the standard occupational`);
w(`-- interpretation of each role. Every one is editable in the admin catalog screens. Nothing here`);
w(`-- is shown to a student as a citation.`);
w(`--`);
w(`-- Timestamps are ISO-8601 UTC (\`strftime\`), never SQLite's bare \`CURRENT_TIMESTAMP\`, which`);
w(`-- renders as \`2026-07-13 14:11:05\` and which JavaScript reads as *local* time`);
w(`-- (src/lib/datetime.ts).`);
w();
w(`-- --- Reset ------------------------------------------------------------------------------`);
w(`--`);
w(`-- Child before parent, all the way down. \`recommendations\` is emptied outright because its`);
w(`-- CHECK constraint admits only CAREER and PROGRAM rows, and both targets are being deleted.`);
w();
w(`DELETE FROM recommendation_explanations;`);
w(`DELETE FROM recommendations;`);
w(`DELETE FROM program_careers;`);
w(`DELETE FROM programs;`);
w(`DELETE FROM program_catalog;`);
w(`DELETE FROM careers;`);
w(`DELETE FROM colleges;`);
w();
w(`-- --- Region VII address hierarchy -------------------------------------------------------`);
w(`--`);
w(`-- Region → Province → Town, migration 0011's tables. Seeded here rather than left NULL (which`);
w(`-- is what seed 0004 did) because this catalog's defining property is a geographic boundary: a`);
w(`-- college row that cannot say which province it is in cannot be checked against the boundary`);
w(`-- it was selected for.`);
w(`--`);
w(`-- \`code\` is the PSGC 9-digit code. Nullable and advisory in the schema, and NULL for every town`);
w(`-- below: migration 0011 already seeded all 47 Bohol municipalities by name with no codes, and`);
w(`-- \`colleges.md\` supplies none. A null says "not recorded", which is true; a plausible-looking`);
w(`-- nine digits would say something stronger and unverified in the column meant to be canonical.`);
w(`--`);
w(`-- \`INSERT OR IGNORE\` here is doing something subtle: \`regions\`, \`provinces\` and \`towns\` carry`);
w(`-- **partial unique indexes on name** (live rows only), so because migration 0011 has already`);
w(`-- created "Tagbilaran City" and every other town below, these inserts are skipped and the ids`);
w(`-- derived here never reach the table. The college inserts that follow therefore resolve by`);
w(`-- *subquery on name*, not by the derived id — which finds whichever row actually exists and`);
w(`-- cannot leave a college pointing at an id that was never inserted.`);
w();

writeInsert('regions', 'id, code, name, created_at, updated_at', [
  `(${q(regionId)}, ${q(REGION.code)}, ${q(REGION.name)}, ${NOW}, ${NOW})`,
]);

writeInsert(
  'provinces',
  'id, region_id, code, name, created_at, updated_at',
  PROVINCES.map(
    (p) =>
      `(${q(provinceIds.get(p.name))}, ${regionLookup()}, ${q(p.code)}, ${q(p.name)}, ${NOW}, ${NOW})`,
  ),
);

writeInsert(
  'towns',
  'id, province_id, code, name, created_at, updated_at',
  TOWNS.map(
    (t) =>
      `(${q(townIds.get(t.name))}, ${provinceLookup(t.province)}, ${q(t.code)}, ${q(t.name)}, ${NOW}, ${NOW})`,
  ),
);

w(`-- --- Institutions (${COLLEGES.length}) ${'-'.repeat(Math.max(1, 62 - String(COLLEGES.length).length))}`);
w(`--`);
w(`-- Every campus listed in \`colleges.md\`, one row each. Bohol has 28 HEIs by CHED RO VII's count;`);
w(`-- these ${COLLEGES.length} campuses are the ones the source document enumerates, and the rest are absent`);
w(`-- rather than guessed at.`);
w(`--`);
w(`-- The list spans all three sectors the province has, which matters because the tier an`);
w(`-- institution sits in changes who can realistically attend it: the state university (BISU, six`);
w(`-- campuses), the private universities and colleges (UB, HNU, BIT ×4, Mater Dei, Bohol Northern`);
w(`-- Star, PMI, Cristal ×2), and the LUC tier funded by a municipal or city ordinance (Buenavista,`);
w(`-- Trinidad, Batuan, Talibon Polytechnic, Tagbilaran City College).`);
w(`--`);
w(`-- \`map_link\` is the institution's own Google Maps share link, copied from \`colleges.md\`. Where`);
w(`-- the source document has no link (BIT Carmen), it falls back to a Maps *search* URL built from`);
w(`-- the campus name and town — an honest "find this place". What is never emitted is a`);
w(`-- \`/maps/place/…\` pin this seed invented, because a pin encodes a surveyed coordinate and`);
w(`-- fabricating one would be seeding a claim rather than a fact.`);
w();
writeInsert(
  'colleges',
  'id, name, description, status, region_id, province_id, town_id, map_link, created_at, updated_at',
  COLLEGES.map((c) => {
    const town = townByName.get(c.town);
    const mapQuery = encodeURIComponent(`${c.name} ${c.town}`).replace(/%20/g, '+');
    const mapLink = c.map ?? `https://www.google.com/maps/search/?api=1&query=${mapQuery}`;
    return (
      `(${q(collegeIds.get(c.key))}, ${q(c.name)}, ${q(c.description)}, 'active', ` +
      `${regionLookup()}, ${provinceLookup(town.province)}, ${townLookup(c.town, town.province)}, ` +
      `${q(mapLink)}, ${NOW}, ${NOW})`
    );
  }),
);

w(`-- --- Careers (${CAREERS.length}) ${'-'.repeat(Math.max(1, 69 - String(CAREERS.length).length))}`);
w(`--`);
w(`-- \`employment_outlook_id\` references the lookup seeded by migration 0013`);
w(`-- (e0000001…4 = Low / Moderate / High / Emerging).`);
w(`--`);
w(`-- The count matters. TOP_N in src/lib/recommendation.ts is 10, so a catalog holding exactly ten`);
w(`-- careers hands every student the entire catalog reordered — two students with opposite RIASEC`);
w(`-- profiles receive identical lists. That is audit C1, and it is the reason this catalog is`);
w(`-- ${CAREERS.length} careers rather than the 10 the source document's summary table enumerates.`);
w(`--`);
w(`-- Every regulated profession's description names the statute and the PRC examination standing`);
w(`-- between graduation and practice. The source is explicit that an automated system must never`);
w(`-- let a degree read as a licence, and the description is where a student reads that.`);
w();
writeInsert(
  'careers',
  'id, title, description, salary_min, salary_max, employment_outlook_id, typical_riasec_code, status, created_at, updated_at',
  CAREERS.map(
    (c) =>
      `(${q(careerIds.get(c.title))}, ${q(c.title)}, ${q(c.description)}, ${c.min}, ${c.max}, ${q(c.outlook)}, ${q(c.riasec)}, 'active', ${NOW}, ${NOW})`,
  ),
);

w(`-- --- Canonical programmes (${PROGRAMS.length}) ${'-'.repeat(Math.max(1, 56 - String(PROGRAMS.length).length))}`);
w(`--`);
w(`-- "BS Computer Science" as a thing in the world, of which each \`programs\` row below is one`);
w(`-- institution's offering. This is what makes "which colleges offer this programme?" a join`);
w(`-- rather than a string match (migration 0018).`);
w(`--`);
w(`-- Normalisation here follows one rule: **collapse titles, preserve scope of practice.** BSCS,`);
w(`-- BSIT, BSIS and BSCpE stay four separate entries because they are four different careers, and`);
w(`-- BSA stays separate from BSMA and BS AIS because only BSA graduates may sit the CPALE under`);
w(`-- RA 9298. What *does* collapse is a single curriculum under two names — "BS Medical`);
w(`-- Technology" and "BS Medical Laboratory Science" are one programme sitting one licensure exam,`);
w(`-- so they are one canonical entry with the institution's own title kept on its offering row.`);
w();
writeInsert(
  'program_catalog',
  'id, code, name, description, status, created_at, updated_at',
  PROGRAMS.map(
    (p) =>
      `(${q(catalogIds.get(p.code))}, ${q(p.code)}, ${q(p.name)}, ${q(p.description)}, 'active', ${NOW}, ${NOW})`,
  ),
);

w(`-- --- Programme offerings (${programRows.length}) ${'-'.repeat(Math.max(1, 57 - String(programRows.length).length))}`);
w(`--`);
w(`-- One row per (institution, canonical programme). Every row carries \`program_catalog_id\`, so`);
w(`-- the sibling offerings of a canonical entry are reachable and the student-facing "where else`);
w(`-- can I study this?" list is populated from the first run.`);
w(`--`);
w(`-- \`recommended_strand\` NULL is a *claim* — "this programme has no strand requirement" — which`);
w(`-- §27 scores as a full 100. It is not "unknown". AB Communication, AB Political Science and the`);
w(`-- Bachelor of Fine Arts are the rows that carry it.`);
w();
writeInsert(
  'programs',
  'id, college_id, program_catalog_id, code, name, department_name, description, recommended_strand, status, created_at, updated_at',
  programRows.map(
    (p) =>
      `(${q(p.id)}, ${q(p.collegeId)}, ${q(p.catalogId)}, ${q(p.code)}, ${q(p.name)}, NULL, ${q(p.description)}, ${q(p.strand)}, 'active', ${NOW}, ${NOW})`,
  ),
);

w(`-- --- Programme ↔ career mapping (${mapRows.length}) ${'-'.repeat(Math.max(1, 50 - String(mapRows.length).length))}`);
w(`--`);
w(`-- **The rows §27 actually ranks programmes on.** A programme's RIASEC compatibility is the`);
w(`-- *average* of its linked careers' Holland codes (\`programRiasecCompatibility\`); a programme`);
w(`-- with no mapping takes the neutral 50 and is indistinguishable from every other unmapped one.`);
w(`--`);
w(`-- The source document classifies pathways as DIRECT, RELATED, CONDITIONAL or BROAD.`);
w(`-- \`program_careers\` has no column for that, so the taxonomy is applied as an editorial rule on`);
w(`-- what gets linked: DIRECT and RELATED are linked, CONDITIONAL is linked where the credential`);
w(`-- is the programme's natural destination, and **BROAD is not linked at all**. Attaching`);
w(`-- transferable-skill roles to every programme would drag every programme's average toward the`);
w(`-- same mean and flatten the ranking this catalog exists to sharpen.`);
w();
writeInsert(
  'program_careers',
  'id, program_id, career_id',
  mapRows.map((m) => `(${q(m.id)}, ${q(m.programId)}, ${q(m.careerId)})`),
);

const sql = out.join('\n');

const summary = [
  `${COLLEGES.length} institutions`,
  `${PROGRAMS.length} canonical programmes`,
  `${programRows.length} offerings`,
  `${CAREERS.length} careers`,
  `${mapRows.length} mappings`,
].join(', ');

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    console.error(`build-region7-seed --check: ${OUT} does not exist. Run the generator.`);
    process.exit(1);
  }
  if (current !== sql) {
    console.error(
      'build-region7-seed --check: seeds/0005_region7_catalog_reset.sql is out of date.\n' +
        'Run `node scripts/build-region7-seed.mjs` and commit the result.',
    );
    process.exit(1);
  }
  console.log(`build-region7-seed --check: seed is current (${summary}).`);
} else {
  writeFileSync(OUT, sql, 'utf8');
  console.log(`build-region7-seed: wrote seeds/0005_region7_catalog_reset.sql — ${summary}.`);
}
