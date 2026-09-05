/**
 * Generates `seeds/0005_region7_catalog_reset.sql` — the Region VII (Central Visayas) academic
 * catalog that replaces seed 0004's nationwide one.
 *
 * ## Why a generator and not hand-written SQL
 *
 * Seeds 0002 and 0004 are hand-committed SQL. That works up to a point; 0004 crossed it. The
 * catalog below is 16 institutions × ~13 programmes × ~4 careers each — well over a thousand rows
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
 * Two source documents, both dated 2026-09-05 and both sourced from CHED RO VII directories,
 * institutional programme pages, and PRC / MARINA registers:
 *
 *   * `Region VII Education Career Database.pdf` — the regional boundary, nine verified
 *     institutions, the normalisation rules, and the pathway taxonomy.
 *   * `Region VII Education Career Database additional.pdf` — seven further institutions
 *     (16 in total), maritime education under MARINA/STCW rather than the PRC, and a
 *     substantially finer career matrix at roughly 2.7 pathways per programme.
 *
 * Their bindings, adopted here verbatim:
 *
 *   * **The region is Bohol and Cebu, and nothing else.** RA 12000 re-established the Negros
 *     Island Region, moving Negros Oriental and Siquijor out of Region VII. Silliman University
 *     — in seed 0004's list — is a Dumaguete institution and is therefore *not* Region VII any
 *     more. Excluding it is the single most consequential edit in this file.
 *   * **The 16 institutions below are the source documents' verified set**, not a sample of a
 *     larger ambition. CHED RO VII counts 139 HEIs in the region — 111 in Cebu, 28 in Bohol;
 *     these 16 are the ones cross-validated to the standard this catalog needs, and the other
 *     123 are absent rather than guessed at. The first document verified nine and the expanded
 *     one added seven, which is why the institution list below is in two blocks.
 *   * **Normalisation preserves scope of practice.** BSCS / BSIT / BSIS / BS CpE stay four
 *     canonical entries because they are four different careers, and BSA stays separate from
 *     BSMA and BS AIS because only BSA graduates may sit the CPALE. Variant *titles* for one
 *     curriculum do collapse: CDU's "BS Medical Technology" and the sector's "BSMLS" are one
 *     canonical programme sitting one licensure exam.
 *   * **A degree is not a licence.** Every regulated career's description says which examination
 *     stands between graduation and practice, and under whose authority — the PRC for most, but
 *     MARINA under the STCW Convention for deck officers and CAAP for aircraft maintenance and
 *     flight crew. Both documents are explicit that an automated system must never imply that
 *     graduating is enough.
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
  { name: 'Cebu', code: '072200000' },
  { name: 'Bohol', code: '071200000' },
];

const TOWNS = [
  { name: 'Cebu City', province: 'Cebu', code: '072217000' },
  { name: 'Mandaue City', province: 'Cebu', code: '072230000' },
  { name: 'Lapu-Lapu City', province: 'Cebu', code: '072226000' },
  { name: 'Tagbilaran City', province: 'Bohol', code: '071241000' },
];

// --- 2. institutions (the 16 verified HEIs) ------------------------------------------------------

const COLLEGES = [
  {
    key: 'USC',
    name: 'University of San Carlos',
    town: 'Cebu City',
    description:
      'A private Catholic research university in Cebu City administered by the Society of the Divine Word (SVD), operating five campuses across the Downtown and Talamban sites. PAASCU Level III accredited, with CHED Centers of Excellence and Development.',
  },
  {
    key: 'CTU',
    name: 'Cebu Technological University',
    town: 'Cebu City',
    description:
      'The primary state technological university of Cebu Province, running 29 campuses from its Cebu City main campus — 16 satellite and 12 extension campuses in municipal hubs including Argao, Barili, Carmen, Danao City, Moalboal, San Francisco and Tuburan. AACCUP accredited and ISO 9001:2015 certified.',
  },
  {
    key: 'UPC',
    name: 'University of the Philippines Cebu',
    town: 'Cebu City',
    description:
      'An autonomous constituent university of the UP System on the Lahug and South Road Properties campuses, recognised for information technology, management, fine arts and environmental science. CHED Center of Excellence in IT and Center of Development in Environmental Science.',
  },
  {
    key: 'USJR',
    name: 'University of San Jose - Recoletos',
    town: 'Cebu City',
    description:
      'A private Catholic university in Cebu City run by the Order of Augustinian Recollects (OAR), across three campuses including Main and Basak. PAASCU accredited, with CHED Centers of Excellence and Development in engineering and business programmes.',
  },
  {
    key: 'CDU',
    name: "Cebu Doctors' University",
    town: 'Mandaue City',
    description:
      'A private non-sectarian health sciences university on North Reclamation Area, Mandaue City, specialising in medicine, nursing and the allied health professions. PAASCU accredited and a recognised healthcare Center of Excellence.',
  },
  {
    key: 'PHILSCA',
    name: 'Philippine State College of Aeronautics - Mactan',
    town: 'Lapu-Lapu City',
    description:
      'The Central Visayas campus of the national aviation state college, at Mactan Air Base in Lapu-Lapu City, delivering aerospace and aviation education. A CAAP-approved training organisation.',
  },
  {
    key: 'BISU',
    name: 'Bohol Island State University',
    town: 'Tagbilaran City',
    description:
      'The state university of Bohol, with its main campus in Tagbilaran City and external campuses in Balilihan, Bilar, Calape, Candijay and Clarin. AACCUP accredited and WURI 2026 ranked.',
  },
  {
    key: 'HNU',
    name: 'Holy Name University',
    town: 'Tagbilaran City',
    description:
      "Bohol's principal private university, an SVD institution on the Dampas campus in Tagbilaran City, offering health sciences, accountancy, engineering and civil law. PAASCU Level III accredited.",
  },
  {
    key: 'UB',
    name: 'University of Bohol',
    town: 'Tagbilaran City',
    description:
      'A private non-sectarian comprehensive university in Poblacion, Tagbilaran City, with programmes spanning liberal arts, criminology, business, engineering and teacher education. PACUCOA accredited.',
  },

  // The seven institutions the expanded source document adds to the nine above. Together they
  // are its "16 major representative universities and colleges", and they widen the catalog in
  // two directions the first nine could not reach on their own: maritime education (UC, BIT),
  // which is one of Cebu's largest employers of graduates and carries a MARINA/STCW credential
  // path rather than a PRC one, and the LUC/college tier (Lapu-Lapu City College, Benedicto,
  // Velez), which is where a large share of Region VII students actually enrol.
  {
    key: 'UC',
    name: 'University of Cebu',
    town: 'Cebu City',
    description:
      'A private non-sectarian university across five Metro Cebu campuses — Main, Banilad, Lapu-Lapu & Mandaue, and the Maritime Education and Training Center — known for maritime education, information technology, criminology, nursing and business.',
  },
  {
    key: 'CITU',
    name: 'Cebu Institute of Technology - University',
    town: 'Cebu City',
    description:
      'A private non-sectarian engineering and technology university on N. Bacalso Avenue, Cebu City, with long-established programmes in mechanical and civil engineering, computer science and architecture.',
  },
  {
    key: 'CNU',
    name: 'Cebu Normal University',
    town: 'Cebu City',
    description:
      'A state university on Osmeña Boulevard, Cebu City, across three campuses. Historically the region’s teacher-training institution, it also offers nursing and the liberal arts.',
  },
  {
    key: 'VELEZ',
    name: 'Velez College',
    town: 'Cebu City',
    description:
      'A private non-sectarian health sciences college on F. Ramos Street, Cebu City, specialising in medical technology, nursing, physical therapy and occupational therapy.',
  },
  {
    key: 'BENEDICTO',
    name: 'Benedicto College',
    town: 'Mandaue City',
    description:
      'A private non-sectarian college with campuses in Mandaue City and Cebu City, focused on technical-vocational education, information technology and business administration.',
  },
  {
    key: 'LLCC',
    name: 'Lapu-Lapu City College',
    town: 'Lapu-Lapu City',
    description:
      'The Local University and College of Lapu-Lapu City, in Gun-ob, established by city ordinance to widen local access to teacher education, hospitality management and criminology.',
  },
  {
    key: 'BIT',
    name: 'BIT International College',
    town: 'Tagbilaran City',
    description:
      'A private non-sectarian college with four Bohol campuses — Tagbilaran City, Carmen, Jagna and Talibon — offering information technology, business administration and maritime studies.',
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
    title: 'Electronics Engineer',
    description:
      'Works on circuits, communications systems and embedded electronics. Regulated under RA 9292 — practice requires passing the PRC Electronics Engineer Licensure Examination.',
    min: 28000,
    max: 105000,
    outlook: OUTLOOK.high,
    riasec: 'IRE',
  },
  {
    title: 'Industrial Engineer',
    description:
      'Improves operations through operations research, quality systems and process design. Non-regulated in the Philippines; certification through professional bodies is optional.',
    min: 30000,
    max: 110000,
    outlook: OUTLOOK.high,
    riasec: 'ECI',
  },
  {
    title: 'Chemical Engineer',
    description:
      'Designs and operates chemical processes and production plant. Regulated under RA 9297 — practice requires passing the PRC Chemical Engineer Licensure Examination.',
    min: 30000,
    max: 115000,
    outlook: OUTLOOK.moderate,
    riasec: 'IRE',
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
    title: 'Marine Engineer',
    description:
      'Operates and maintains shipboard machinery and propulsion systems. Regulated under the STCW Convention and RA 10635 — practice requires a MARINA/PRC Certificate of Competency following approved sea service.',
    min: 40000,
    max: 200000,
    outlook: OUTLOOK.high,
    riasec: 'RCE',
  },

  // Aviation
  {
    title: 'Aeronautical Engineer',
    description:
      'Designs, analyses and certifies aircraft structures and systems. Regulated under RA 9836 — practice requires passing the PRC Aeronautical Engineer Licensure Examination.',
    min: 35000,
    max: 130000,
    outlook: OUTLOOK.emerging,
    riasec: 'IRE',
  },
  {
    title: 'Aircraft Maintenance Technician',
    description:
      'Inspects, services and certifies airworthiness of aircraft and components. Requires a CAAP Aircraft Maintenance Technician licence, not a PRC one — the airworthiness authority is the Civil Aviation Authority of the Philippines.',
    min: 25000,
    max: 120000,
    outlook: OUTLOOK.emerging,
    riasec: 'RCI',
  },
  {
    title: 'Avionics Technician',
    description:
      'Maintains and repairs aircraft electronic systems — navigation, communication and instrumentation. Licensed by CAAP under its avionics rating.',
    min: 24000,
    max: 100000,
    outlook: OUTLOOK.emerging,
    riasec: 'CRI',
  },
  {
    title: 'Commercial Pilot',
    description:
      'Flies aircraft for commercial air operators. Requires a CAAP Commercial Pilot Licence with logged flight hours and recurrent medical certification — the degree alone confers no flying privilege.',
    min: 70000,
    max: 300000,
    outlook: OUTLOOK.moderate,
    riasec: 'RIE',
  },

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
    title: 'Medical Technologist',
    description:
      'Performs clinical specimen analysis, diagnostic testing and blood banking in hospital and reference laboratories. Regulated under RA 5527 — BSMT and BSMLS graduates alike must pass the Medical Technologist Licensure Examination before practising.',
    min: 24000,
    max: 75000,
    outlook: OUTLOOK.high,
    riasec: 'ICR',
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
    title: 'Nutritionist-Dietitian',
    description:
      'Plans clinical, community and food-service nutrition programmes. Regulated under RA 10862 — practice requires passing the PRC Nutritionist-Dietitian Licensure Examination.',
    min: 21000,
    max: 65000,
    outlook: OUTLOOK.moderate,
    riasec: 'SIC',
  },
  {
    title: 'Radiologic Technologist',
    description:
      'Operates diagnostic imaging equipment and applies radiation safety practice. Regulated under RA 7431 — practice requires passing the PRC Radiologic Technology Licensure Examination.',
    min: 21000,
    max: 70000,
    outlook: OUTLOOK.moderate,
    riasec: 'RIS',
  },
  {
    title: 'Respiratory Therapist',
    description:
      'Manages ventilation and cardiopulmonary care for critically ill patients. Regulated under RA 10024 — practice requires passing the PRC Respiratory Therapist Licensure Examination.',
    min: 21000,
    max: 65000,
    outlook: OUTLOOK.moderate,
    riasec: 'SIC',
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
    title: 'Management Accountant',
    description:
      'Runs cost accounting, budgeting and internal performance reporting inside a business. A non-licensure track: Certified Management Accountant (CMA) certification, not PRC registration, is the recognised credential.',
    min: 28000,
    max: 110000,
    outlook: OUTLOOK.high,
    riasec: 'CEI',
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
  {
    title: 'Technical-Vocational Teacher',
    description:
      'Teaches technical and vocational subjects in DepEd senior high schools and TESDA training centres. Requires both the PRC Licensure Examination for Teachers and the relevant TESDA National Certificate (NC II/III) in the trade being taught.',
    min: 27000,
    max: 55000,
    outlook: OUTLOOK.high,
    riasec: 'SRE',
  },
  {
    title: 'Special Needs Education Teacher',
    description:
      'Teaches learners with disabilities and additional needs in inclusive and specialised settings. Regulated under RA 7836 — requires passing the Licensure Examination for Teachers.',
    min: 27000,
    max: 55000,
    outlook: OUTLOOK.moderate,
    riasec: 'SAE',
  },

  // Psychology, social work and public safety
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
    title: 'Social Worker',
    description:
      'Delivers casework, community organising and social protection services for LGUs, DSWD and NGOs. Regulated under RA 4373 — practice requires passing the PRC Social Worker Licensure Examination.',
    min: 20000,
    max: 60000,
    outlook: OUTLOOK.moderate,
    riasec: 'SEC',
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
    title: 'Environmental Scientist',
    description:
      'Assesses environmental impact and advises on remediation and compliance for industry and LGUs. Non-regulated as a profession, though environmental impact work is governed by DENR accreditation.',
    min: 28000,
    max: 85000,
    outlook: OUTLOOK.high,
    riasec: 'IRS',
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
  {
    title: 'Chemist',
    description:
      'Analyses substances and develops compounds in laboratory and industrial settings. Regulated under RA 10657 — practice as a chemist requires passing the PRC Chemist Licensure Examination.',
    min: 26000,
    max: 80000,
    outlook: OUTLOOK.moderate,
    riasec: 'IRC',
  },
  {
    title: 'Statistician',
    description:
      'Designs studies and analyses data to quantify uncertainty and test hypotheses, for research units and government statistics offices. Non-regulated.',
    min: 32000,
    max: 95000,
    outlook: OUTLOOK.high,
    riasec: 'ICE',
  },
  {
    title: 'Actuary',
    description:
      'Prices risk for insurers and pension funds using probability and statistics. Non-regulated in the Philippines, but accreditation by the Actuarial Society of the Philippines is the working requirement for signing statutory valuations.',
    min: 50000,
    max: 180000,
    outlook: OUTLOOK.high,
    riasec: 'ICE',
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
    title: 'Journalist',
    description:
      'Reports, writes and produces news for broadcast, print and digital outlets. Non-regulated.',
    min: 18000,
    max: 70000,
    outlook: OUTLOOK.moderate,
    riasec: 'AIS',
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
    title: 'Blood Bank Specialist',
    description:
      'Performs blood typing, crossmatching, transfusion safety and component processing for the Philippine Red Cross and tertiary hospitals. Requires the PRC Medical Technologist licence under RA 5527, plus blood banking certification.',
    min: 25000,
    max: 80000,
    outlook: OUTLOOK.moderate,
    riasec: 'ICR',
  },
  {
    title: 'Molecular Diagnostics Specialist',
    description:
      'Runs real-time PCR testing, DNA/RNA extraction and next-generation sequencing in genetic testing labs and research centres. Built on the PRC Medical Technologist licence, with molecular biology certification as the specialisation.',
    min: 30000,
    max: 95000,
    outlook: OUTLOOK.emerging,
    riasec: 'IRC',
  },
  {
    title: 'Occupational Therapist',
    description:
      'Enables participation in everyday occupations after injury, illness or developmental difficulty. Regulated under RA 5680 — practice requires passing the PRC Occupational Therapist Licensure Examination.',
    min: 24000,
    max: 80000,
    outlook: OUTLOOK.moderate,
    riasec: 'SIR',
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
  // Computing — four entries, deliberately. The PDF is explicit that these are four different
  // careers and must not be normalised together.
  { code: 'BSCS', name: 'BS Computer Science', strand: A, description: 'Computational theory, algorithm design and software architecture.' },
  { code: 'BSIT', name: 'BS Information Technology', strand: A, description: 'Systems administration, network infrastructure and web application deployment.' },
  { code: 'BSIS', name: 'BS Information Systems', strand: A, description: 'Business process integration and enterprise software systems.' },
  { code: 'BSCPE', name: 'BS Computer Engineering', strand: A, description: 'Hardware-software interfaces, embedded circuit design and computer architecture.' },

  // Engineering
  { code: 'BSCE', name: 'BS Civil Engineering', strand: A, description: 'Structural calculation, reinforced concrete design, hydraulics and construction cost estimation.' },
  { code: 'BSME', name: 'BS Mechanical Engineering', strand: A, description: 'Thermodynamics, machine design and manufacturing systems.' },
  { code: 'BSEE', name: 'BS Electrical Engineering', strand: A, description: 'Power systems, electrical machines and building electrical design.' },
  { code: 'BSECE', name: 'BS Electronics Engineering', strand: A, description: 'Circuits, communications systems and embedded electronics.' },
  { code: 'BSIE', name: 'BS Industrial Engineering', strand: A, description: 'Operations research, quality systems and process improvement.' },
  { code: 'BSCHE', name: 'BS Chemical Engineering', strand: A, description: 'Process design, transport phenomena and plant operations.' },
  { code: 'BSMARE', name: 'BS Marine Engineering', strand: T, description: 'Shipboard machinery, propulsion and marine systems, with supervised sea service.' },
  // Maritime deck officers are credentialled by MARINA under STCW rather than by the PRC, which
  // is why this is its own canonical entry and not a variant of Marine Engineering. Note the
  // code: institutions abbreviate BS Marine Transportation as "BSMT", which is also how BS
  // Medical Technology is abbreviated. Both keep their own abbreviation on their offering rows
  // — that ambiguity is real and a student will meet it — while the canonical codes stay
  // distinct, because `program_catalog.code` is what one programme is looked up by.
  { code: 'BSMARTRANS', name: 'BS Marine Transportation', strand: T, description: 'Ocean navigation, watchkeeping, passage planning, cargo operations and collision regulations.' },
  { code: 'BSARCH', name: 'BS Architecture', strand: A, description: 'Architectural design, building code compliance, AutoCAD and Revit (BIM) practice.' },
  { code: 'BSID', name: 'BS Interior Design', strand: A, description: 'Interior space planning, materials and detailing.' },

  // Aviation
  { code: 'BSAERO', name: 'BS Aeronautical Engineering', strand: A, description: 'Aircraft structures, aerodynamics and propulsion systems.' },
  { code: 'BSAMT', name: 'BS Aircraft Maintenance Technology', strand: T, description: 'Airframe and powerplant maintenance to CAAP airworthiness standards.' },
  { code: 'BSAVTECH', name: 'BS Aviation Electronics Technology', strand: T, description: 'Aircraft navigation, communication and instrumentation systems.' },
  { code: 'BSAIRT', name: 'BS Air Transportation', strand: T, description: 'Flying training, air navigation and aviation regulation toward a CAAP pilot licence.' },

  // Health sciences
  { code: 'BSN', name: 'BS Nursing', strand: A, description: 'Clinical patient care, IV therapy, bedside assessment and emergency response.' },
  { code: 'BSMLS', name: 'BS Medical Laboratory Science', strand: A, description: 'Haematology analysis, blood chemistry, microbiology culture and histopathology. Offered as "BS Medical Technology" at some institutions — the same curriculum and the same licensure examination.' },
  { code: 'BSPHARM', name: 'BS Pharmacy', strand: A, description: 'Pharmaceutical science, dispensing and pharmacy practice.' },
  { code: 'BSPT', name: 'BS Physical Therapy', strand: A, description: 'Rehabilitation of movement and physical function.' },
  { code: 'BSND', name: 'BS Nutrition and Dietetics', strand: A, description: 'Clinical, community and food-service nutrition.' },
  { code: 'BSRT', name: 'BS Radiologic Technology', strand: A, description: 'Diagnostic imaging and radiation safety.' },
  { code: 'BSRESPT', name: 'BS Respiratory Therapy', strand: A, description: 'Ventilation management and cardiopulmonary care.' },
  { code: 'BSOT', name: 'BS Occupational Therapy', strand: A, description: 'Enabling participation in everyday occupations after injury, illness or developmental difficulty.' },

  // Accountancy and business — BSA is kept separate from BSMA and BS AIS because only BSA
  // graduates may sit the CPALE (RA 9298). This is the PDF's central normalisation rule.
  { code: 'BSA', name: 'BS Accountancy', strand: A, description: 'Financial auditing, PFRS/IAS standards, internal controls and tax compliance. The only accounting track whose graduates may sit the CPA Licensure Examination.' },
  { code: 'BSMA', name: 'BS Management Accounting', strand: A, description: 'Corporate management accounting, cost analysis and internal reporting. A non-licensure track oriented toward CMA certification rather than PRC registration.' },
  { code: 'BSAIS', name: 'BS Accounting Information Systems', strand: A, description: 'Accounting systems, controls and business process automation. A non-licensure track.' },
  { code: 'BSBA', name: 'BS Business Administration', strand: A, description: 'Management, marketing, finance and operations.' },
  { code: 'BSBM', name: 'BS Business Management', strand: A, description: 'Supply chain optimisation, business strategy, process mapping and HR analytics.' },
  { code: 'BSENTREP', name: 'BS Entrepreneurship', strand: A, description: 'Venture creation, business planning and small enterprise management.' },
  { code: 'BSHM', name: 'BS Hospitality Management', strand: T, description: 'Hotel, restaurant and events operations.' },
  { code: 'BSTM', name: 'BS Tourism Management', strand: T, description: 'Destination management, travel operations and visitor services.' },

  // Education
  { code: 'BEED', name: 'Bachelor of Elementary Education', strand: A, description: 'Elementary teaching, curriculum and assessment.' },
  { code: 'BSED', name: 'Bachelor of Secondary Education', strand: A, description: 'Secondary teaching with a subject major.' },
  { code: 'BTVTED', name: 'Bachelor of Technical-Vocational Teacher Education', strand: T, description: 'Pedagogical design, technical drafting, CAD instruction and TVET assessment.' },
  { code: 'BSNED', name: 'Bachelor of Special Needs Education', strand: A, description: 'Inclusive and special needs teaching practice.' },

  // Social sciences, law enforcement, communication and the arts
  { code: 'BSPSY', name: 'BS Psychology', strand: A, description: 'Behavioural science, psychological assessment and research methods.' },
  { code: 'BSSW', name: 'BS Social Work', strand: A, description: 'Casework, community organising and social policy.' },
  { code: 'BSCRIM', name: 'BS Criminology', strand: A, description: 'Crime scene investigation, Philippine criminal law, criminalistics and forensic ballistics.' },
  { code: 'ABCOM', name: 'AB Communication', strand: null, description: 'Media production, writing and communication theory.' },
  { code: 'ABPOLSCI', name: 'AB Political Science', strand: null, description: 'Government, law and political theory.' },
  { code: 'BFA', name: 'Bachelor of Fine Arts', strand: null, description: 'Studio practice across visual, product and applied arts.' },

  // Sciences, environment, marine and agriculture
  { code: 'BSBIO', name: 'BS Biology', strand: A, description: 'Organismal, cellular and ecological biology.' },
  { code: 'BSMARBIO', name: 'BS Marine Biology', strand: A, description: 'Marine organisms, reef ecosystems and coastal resource science.' },
  { code: 'BSENVSCI', name: 'BS Environmental Science', strand: A, description: 'Environmental systems, impact assessment and management.' },
  { code: 'BSCHEM', name: 'BS Chemistry', strand: A, description: 'Analytical, organic and physical chemistry.' },
  { code: 'BSMATH', name: 'BS Mathematics', strand: A, description: 'Pure and applied mathematical structures and methods.' },
  { code: 'BSFISH', name: 'BS Fisheries', strand: T, description: 'Aquaculture, capture fisheries and aquatic resource management.' },
  { code: 'BSAGRI', name: 'BS Agriculture', strand: T, description: 'Crop science, animal science and farm management.' },
];

// --- 5. offerings ---------------------------------------------------------------------------------
//
// Which of the 16 institutions offers which canonical programme. A bare code means the
// institution uses the canonical title; `'BSMLS as BSMT/BS Medical Technology'` records an
// institution whose own title differs — `programs.code`/`programs.name` keep what the institution
// calls it, `program_catalog_id` links it to what it *is*. That split is what lets a student see
// "BS Medical Technology at CDU" and still find every other Region VII institution teaching the
// same curriculum.

const OFFERINGS = {
  USC: [
    'BSCS', 'BSIT', 'BSIS', 'BSCPE',
    'BSCE', 'BSME', 'BSEE', 'BSECE', 'BSIE', 'BSCHE',
    'BSARCH', 'BSID',
    'BSA', 'BSMA', 'BSBA', 'BSHM', 'BSTM',
    'BSPSY', 'BSSW', 'ABCOM', 'ABPOLSCI', 'BFA',
    'BSBIO', 'BSCHEM', 'BSMATH', 'BSENVSCI',
    'BSPHARM', 'BSND',
    'BEED', 'BSED',
  ],
  CTU: [
    'BSIT', 'BSCS', 'BSCPE',
    'BSCE', 'BSME', 'BSEE', 'BSECE', 'BSIE', 'BSMARE',
    'BTVTED', 'BEED', 'BSED',
    'BSBA', 'BSENTREP', 'BSHM', 'BSTM',
    'BSAGRI', 'BSFISH',
    'BSMATH', 'BSCRIM',
  ],
  UPC: [
    'BSCS',
    'BSBM as BSM/BS Management',
    'BFA', 'BSENVSCI', 'BSBIO', 'BSMATH',
    'ABCOM', 'ABPOLSCI',
  ],
  USJR: [
    'BSCS', 'BSIT', 'BSIS', 'BSCPE',
    'BSCE', 'BSME', 'BSEE', 'BSECE', 'BSIE',
    'BSA', 'BSMA', 'BSAIS', 'BSBA', 'BSHM',
    'BEED', 'BSED',
    'BSPSY', 'BSCRIM',
  ],
  CDU: [
    'BSN',
    'BSMLS as BSMT/BS Medical Technology',
    'BSPT', 'BSPHARM', 'BSND', 'BSRT', 'BSRESPT',
    'BSPSY', 'BSBIO',
  ],
  PHILSCA: ['BSAERO', 'BSAMT', 'BSAVTECH', 'BSAIRT'],
  BISU: [
    'BSCE', 'BSME', 'BSEE', 'BSECE', 'BSCPE',
    'BSIT', 'BSCS',
    'BTVTED', 'BEED', 'BSED',
    'BSHM', 'BSTM',
    'BSAGRI', 'BSFISH', 'BSMARBIO',
    'BSCRIM', 'BSMATH',
  ],
  HNU: [
    'BSPSY', 'BSCRIM', 'BSSW',
    'BSA', 'BSMA', 'BSBA', 'BSHM', 'BSTM',
    'BSN',
    'BSMLS as BSMT/BS Medical Technology',
    'BSPHARM',
    'BSCE', 'BSCPE', 'BSIT', 'BSCS',
    'BEED', 'BSED', 'BSNED', 'ABCOM',
  ],
  UB: [
    'BSN', 'BSCRIM',
    'BSCE', 'BSEE', 'BSME',
    'BSIT', 'BSCS',
    'BSBA', 'BSA', 'BSHM', 'BSTM',
    'BEED', 'BSED', 'BSPSY',
    'BSMARE',
  ],

  // --- The expanded source document's seven additional institutions ------------------------
  UC: [
    // "BSMT" here is BS Marine Transportation, and "BSMT" at CDU and HNU is BS Medical
    // Technology. Both are what the institution actually prints on the diploma; the canonical
    // entry each one links to is what tells them apart.
    'BSMARTRANS as BSMT/BS Marine Transportation',
    'BSMARE',
    'BSIT', 'BSCS',
    'BSCRIM', 'BSN', 'BSPSY',
    'BSBA', 'BSA', 'BSHM', 'BSTM',
    'BEED', 'BSED',
    'BSCE',
  ],
  CITU: [
    'BSME', 'BSCE', 'BSEE', 'BSECE', 'BSIE', 'BSCPE', 'BSCHE',
    'BSARCH',
    'BSCS', 'BSIT',
    'BSMATH',
    'BSBA', 'BSA',
  ],
  CNU: [
    'BEED', 'BSED', 'BSNED',
    'BSN',
    'BSPSY', 'ABCOM', 'ABPOLSCI',
    'BSBIO', 'BSMATH',
    'BSTM',
  ],
  VELEZ: [
    'BSMLS as BSMT/BS Medical Technology',
    'BSN', 'BSPT', 'BSOT',
  ],
  BENEDICTO: [
    'BTVTED',
    'BSIT', 'BSCS',
    'BSBA', 'BSHM',
    'BSCRIM',
    'BEED', 'BSED',
  ],
  LLCC: [
    'BEED', 'BSED',
    'BSHM', 'BSCRIM',
    'BSIT', 'BSBA',
  ],
  BIT: [
    'BSIT', 'BSCS',
    'BSBA', 'BSHM',
    'BSMARTRANS as BSMT/BS Marine Transportation',
    'BSMARE',
    'BSCRIM',
  ],
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
  BSCPE: ['Computer Engineer', 'Network Engineer', 'Software Developer', 'Systems Administrator'],

  BSCE: ['Civil Engineer', 'Geotechnical Engineer', 'Construction Project Manager', 'Quantity Surveyor', 'BIM Specialist'],
  BSME: ['Mechanical Engineer', 'HVAC Design Engineer', 'Power Plant Engineer', 'Construction Project Manager', 'Industrial Engineer'],
  BSEE: ['Electrical Engineer', 'Power Plant Engineer', 'Construction Project Manager', 'Industrial Engineer'],
  BSECE: ['Electronics Engineer', 'Network Engineer', 'Computer Engineer'],
  BSIE: ['Industrial Engineer', 'Operations Manager', 'Supply Chain Analyst', 'Quality Assurance Engineer'],
  BSCHE: ['Chemical Engineer', 'Chemist', 'Environmental Scientist', 'Industrial Engineer'],
  BSMARE: ['Marine Engineer', 'Power Plant Engineer', 'Port Operations Supervisor', 'Mechanical Engineer'],
  BSMARTRANS: ['Deck Officer', 'Marine Surveyor', 'Port Operations Supervisor', 'Ship Captain'],
  BSARCH: ['Architect', 'BIM Specialist', 'Urban and Regional Planner', 'Construction Project Manager', 'Interior Designer', 'Quantity Surveyor'],
  BSID: ['Interior Designer', 'CAD Design Technician', 'Graphic Designer', 'Architect'],

  BSAERO: ['Aeronautical Engineer', 'Aircraft Maintenance Technician', 'Mechanical Engineer'],
  BSAMT: ['Aircraft Maintenance Technician', 'Avionics Technician'],
  BSAVTECH: ['Avionics Technician', 'Aircraft Maintenance Technician', 'Electronics Engineer'],
  BSAIRT: ['Commercial Pilot', 'Aircraft Maintenance Technician'],

  BSN: ['Registered Nurse', 'Public Health Nurse', 'Clinical Researcher', 'Nurse Administrator', 'Public Health Officer'],
  BSMLS: ['Medical Technologist', 'Blood Bank Specialist', 'Molecular Diagnostics Specialist', 'Clinical Researcher', 'Laboratory Research Associate'],
  BSPHARM: ['Pharmacist', 'Clinical Researcher', 'Laboratory Research Associate'],
  BSPT: ['Physical Therapist', 'Public Health Officer'],
  BSOT: ['Occupational Therapist', 'Physical Therapist', 'Public Health Officer'],
  BSND: ['Nutritionist-Dietitian', 'Public Health Officer'],
  BSRT: ['Radiologic Technologist', 'Public Health Officer'],
  BSRESPT: ['Respiratory Therapist', 'Public Health Officer'],

  BSA: ['Certified Public Accountant', 'Tax Advisory Specialist', 'Financial Analyst', 'Internal Auditor', 'Chief Financial Officer'],
  BSMA: ['Management Accountant', 'Financial Analyst', 'Internal Auditor', 'Chief Financial Officer'],
  BSAIS: ['Business Systems Analyst', 'Management Accountant', 'Internal Auditor', 'Data Analyst'],
  BSBA: ['Marketing Specialist', 'Operations Manager', 'Business Development Specialist', 'Human Resources Specialist', 'Bank Operations Officer', 'Financial Analyst'],
  BSBM: ['Operations Manager', 'Business Development Specialist', 'Supply Chain Analyst', 'Human Resources Specialist', 'Financial Analyst'],
  BSENTREP: ['Entrepreneur', 'Business Development Specialist', 'Marketing Specialist', 'Operations Manager'],
  BSHM: ['Hotel Operations Manager', 'Operations Manager', 'Entrepreneur'],
  BSTM: ['Tourism Officer', 'Hotel Operations Manager', 'Marketing Specialist'],

  BEED: ['Elementary School Teacher', 'Special Needs Education Teacher', 'Curriculum Developer', 'Guidance Counselor'],
  BSED: ['Secondary School Teacher', 'Curriculum Developer', 'Guidance Counselor'],
  BTVTED: ['Technical-Vocational Teacher', 'CAD Design Technician', 'Secondary School Teacher'],
  BSNED: ['Special Needs Education Teacher', 'Elementary School Teacher', 'Social Worker'],

  BSPSY: ['Psychometrician', 'Human Resources Specialist', 'Clinical Psychologist', 'Guidance Counselor', 'Clinical Researcher'],
  BSSW: ['Social Worker', 'Public Health Officer', 'Public Administration Officer'],
  BSCRIM: ['Registered Criminologist', 'Police Officer', 'Crime Scene Investigator', 'Correctional Officer', 'Public Administration Officer'],
  ABCOM: ['Communications Officer', 'Journalist', 'Marketing Specialist', 'Multimedia Artist'],
  ABPOLSCI: ['Public Administration Officer', 'Communications Officer', 'Journalist'],
  BFA: ['Multimedia Artist', 'Graphic Designer', 'UI/UX Designer'],

  BSBIO: ['Laboratory Research Associate', 'Marine Biologist', 'Environmental Scientist', 'Clinical Researcher'],
  BSMARBIO: ['Marine Biologist', 'Aquatic Resource Specialist', 'Environmental Scientist', 'Fisheries Technologist', 'Laboratory Research Associate'],
  BSENVSCI: ['Environmental Scientist', 'Public Health Officer', 'Laboratory Research Associate'],
  BSCHEM: ['Chemist', 'Laboratory Research Associate', 'Medical Technologist', 'Environmental Scientist'],
  BSMATH: ['Statistician', 'Actuary', 'Data Analyst', 'Secondary School Teacher'],
  BSFISH: ['Fisheries Technologist', 'Aquatic Resource Specialist', 'Marine Biologist', 'Agriculturist'],
  BSAGRI: ['Agriculturist', 'Environmental Scientist', 'Entrepreneur'],
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

w(`-- Seed 0005 — the Region VII (Central Visayas) academic catalog. **Generated file.**`);
w(`--`);
w(`-- Edit \`scripts/build-region7-seed.mjs\` and re-run \`node scripts/build-region7-seed.mjs\`.`);
w(`-- Editing this file by hand works exactly once, until the next regeneration overwrites it, and`);
w(`-- \`npm run seed:region7:check\` fails the build in the meantime.`);
w(`--`);
w(`-- ## What this file does`);
w(`--`);
w(`-- It is a **reset**, not an addition. Seed 0004 seeded a nationwide catalog — 20 institutions`);
w(`-- from Diliman to Iligan — and this replaces it wholesale with the Region VII catalog described`);
w(`-- in \`Region VII Education Career Database.pdf\` (2026-09-05, sourced from CHED RO VII`);
w(`-- directories, institutional programme pages and PRC board registers).`);
w(`--`);
w(`-- The boundary is the point. RA 12000 re-established the Negros Island Region, so Region VII is`);
w(`-- **Bohol and Cebu only** — Negros Oriental and Siquijor moved to NIR, and Silliman University,`);
w(`-- which seed 0004 lists, is a Dumaguete institution that no longer belongs in this region's`);
w(`-- catalog at all. A student in Cebu asking "where can I study this?" was being shown Manila.`);
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
w(`-- \`code\` is the PSGC 9-digit code. Nullable and advisory in the schema.`);
w(`--`);
w(`-- \`INSERT OR IGNORE\` here is doing something subtle: \`regions\`, \`provinces\` and \`towns\` carry`);
w(`-- **partial unique indexes on name** (live rows only), so if an admin has already created`);
w(`-- "Cebu City" through the address screens, these inserts are skipped and the ids below never`);
w(`-- reach the table. The college inserts that follow therefore resolve their location by`);
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
w(`-- The PDF's fully-verified set. CHED RO VII counts 139 HEIs across Cebu (111) and Bohol (28);`);
w(`-- these ${COLLEGES.length} are the ones cross-validated against CHED directories, institutional`);
w(`-- prospectuses and PRC registers. The other ${139 - COLLEGES.length} are absent rather than guessed at.`);
w(`--`);
w(`-- The list spans all three sectors the region actually has, which matters because the tier an`);
w(`-- institution sits in changes who can realistically attend it: state universities (CTU, UP`);
w(`-- Cebu, CNU, BISU, PhilSCA), private universities and colleges (USC, USJ-R, UC, CIT-U, CDU,`);
w(`-- Velez, Benedicto, HNU, UB, BIT), and the LUC tier funded by a city ordinance`);
w(`-- (Lapu-Lapu City College).`);
w(`--`);
w(`-- \`map_link\` is a Google Maps *search* URL built from the institution's name and city — an`);
w(`-- honest "find this place" link. It is deliberately not a \`/maps/place/…\` pin, because a pin`);
w(`-- encodes a surveyed coordinate this seed does not have and inventing one would be fabricating`);
w(`-- a fact rather than seeding one.`);
w();
writeInsert(
  'colleges',
  'id, name, description, status, region_id, province_id, town_id, map_link, created_at, updated_at',
  COLLEGES.map((c) => {
    const town = townByName.get(c.town);
    const mapQuery = encodeURIComponent(`${c.name} ${c.town}`).replace(/%20/g, '+');
    const mapLink = `https://www.google.com/maps/search/?api=1&query=${mapQuery}`;
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
