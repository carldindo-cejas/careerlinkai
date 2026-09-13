/**
 * **The words students use that the catalog does not store** (IMPLEMENT-kb-grounding.md §5.4 and
 * §6, 2026-09-13).
 *
 * Gate 2 (`modules/ai/results-answer-service.ts`) binds a question to a career by its title, its
 * plural and its initials. Students write "nurse", "pulis", "accountant" and "maging seaman" — none
 * of them a stored title — and those questions fell through to retrieval, where the model sees a
 * handful of passages instead of the complete list.
 *
 * Three tables, hand-written and checked by `test/ai/catalog-vocabulary.test.ts`:
 *
 *   * `CAREER_ALIASES` — extra names for one career. **Every alias names exactly one career.** A
 *     word that honestly covers several is not an alias; it goes in `VAGUE_CAREER_TERMS`.
 *   * `VAGUE_CAREER_TERMS` — "engineer", "teacher", "seaman". Answered with the careers the word
 *     could mean and the program behind each, so the student picks rather than the matcher.
 *   * `CATALOG_GAPS` — programs students ask for that no college in the catalog offers. Answered
 *     with what is true about the route and the related programs that *are* offered.
 *
 * Keyed by title and program name rather than id: the Region VII seed deletes and re-inserts the
 * catalog, and a title is what an admin sees. A title that stops existing simply stops matching. A
 * gap is checked against the live catalog on every turn, so it stops firing the moment a college
 * adds the program.
 *
 * Every form is written normalised — lower case, punctuation as spaces (`normaliseQuestion`) —
 * because that is the text it is matched against.
 *
 * **No figures, no school names, no fees in a gap note.** It says only what is true everywhere —
 * which degree, which licensure examination — because a wrong detail here reaches a student
 * choosing a degree.
 */

/** Extra names for one career, keyed by its catalog title. */
export const CAREER_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'Certified Public Accountant': ['accountant', 'accountants'],
  'Registered Nurse': ['nurse', 'nurses', 'nars'],
  'Police Officer': ['police', 'pulis', 'polis', 'pnp', 'policeman', 'policewoman', 'kapulisan'],
  'Registered Criminologist': ['criminologist', 'criminologists'],
  'Fire Officer': ['firefighter', 'firefighters', 'fireman', 'bumbero', 'bombero', 'bfp'],
  'Correctional Officer': ['jail guard', 'prison guard', 'jail officer', 'bjmp'],
  Lawyer: ['abogado', 'abogada', 'abugado', 'attorney', 'attorneys'],
  'Software Developer': [
    'programmer',
    'programmers',
    'coder',
    'coders',
    'software engineer',
    'software engineers',
    'web developer',
    'web developers',
    'app developer',
    'app developers',
  ],
  'Elementary School Teacher': ['elementary teacher', 'elementary teachers', 'grade school teacher'],
  'Secondary School Teacher': ['high school teacher', 'high school teachers', 'secondary teacher'],
  'Physical Education Teacher': ['pe teacher', 'pe teachers', 'p e teacher'],
  Architect: ['arkitekto'],
  Midwife: ['midwives', 'komadrona', 'mananabang', 'partera'],
  Entrepreneur: [
    'negosyante',
    'business owner',
    'businessman',
    'businesswoman',
    'magnegosyo',
    'mag negosyo',
  ],
  Pharmacist: ['parmasyutiko'],
  'Physical Therapist': ['physiotherapist', 'physiotherapists'],
  'Clinical Psychologist': ['psychologist', 'psychologists'],
  'Ship Captain': ['kapitan', 'ship master', 'master mariner'],
  Agriculturist: ['farmer', 'farmers', 'magsasaka', 'mag uuma'],
  Journalist: ['reporter', 'reporters', 'news reporter', 'broadcaster', 'peryodista'],
  'Multimedia Artist': ['animator', 'animators', 'video editor', 'video editors'],
  'Graphic Designer': ['graphic artist', 'layout artist'],
  'Hotel Operations Manager': ['hotel manager', 'hotelier'],
  'Guidance Counselor': ['guidance counsellor'],
};

export interface VagueCareerTerm {
  /** How the answer names the word: “Engineer” can mean several careers. */
  label: string;
  forms: readonly string[];
  /** The careers it could mean, by catalog title, in the order to list them. */
  careers: readonly string[];
}

export const VAGUE_CAREER_TERMS: readonly VagueCareerTerm[] = [
  {
    label: 'Engineer',
    forms: ['engineer', 'engineers', 'engineering', 'inhinyero', 'enhinyero', 'engr'],
    careers: [
      'Civil Engineer',
      'Electrical Engineer',
      'Mechanical Engineer',
      'Computer Engineer',
      'Marine Engineer',
      'Agricultural and Biosystems Engineer',
    ],
  },
  {
    label: 'Teacher',
    forms: ['teacher', 'teachers', 'titser', 'maestra', 'maestro', 'magtutudlo', 'guro', 'teaching'],
    careers: ['Elementary School Teacher', 'Secondary School Teacher', 'Physical Education Teacher'],
  },
  {
    label: 'Seaman',
    forms: ['seaman', 'seamen', 'sea man', 'seafarer', 'seafarers', 'marino', 'marinero'],
    careers: ['Deck Officer', 'Marine Engineer'],
  },
  {
    label: 'Technician',
    forms: ['technician', 'technicians'],
    careers: ['Electrical Technician', 'Electronics Technician', 'Instrumentation Technician'],
  },
  {
    label: 'Designer',
    forms: ['designer', 'designers'],
    careers: ['Graphic Designer', 'UI/UX Designer', 'Interior Designer', 'Industrial Designer'],
  },
];

export interface CatalogGap {
  /** Read after "offers": No college in the catalog offers {name}. */
  name: string;
  forms: readonly string[];
  /** A catalog program whose name contains any of these means the gap has closed. */
  offeredAs: readonly string[];
  /** What is true about the route anywhere in the country. No figures, no school names. */
  note: string;
  /** Catalog program names to list instead — shown only where a college offers them. */
  nearest: readonly string[];
}

export const CATALOG_GAPS: readonly CatalogGap[] = [
  {
    name: 'a Doctor of Medicine program',
    forms: [
      'doctor',
      'doctors',
      'doktor',
      'physician',
      'physicians',
      'medical doctor',
      'doctor of medicine',
      'medicine',
      'med school',
      'medical school',
      'surgeon',
      'surgeons',
      'pre med',
      'premed',
    ],
    offeredAs: ['doctor of medicine'],
    note: 'Medicine is a graduate degree in the Philippines: you first finish a bachelor’s degree (your pre-med), then take the NMAT and apply to a Doctor of Medicine program, and after it the PRC Physician Licensure Examination.',
    nearest: ['BS Nursing', 'BS Pharmacy', 'BS Physical Therapy', 'BS Psychology'],
  },
  {
    name: 'Dentistry',
    forms: [
      'dentist',
      'dentists',
      'dentista',
      'dentistry',
      'dental',
      'dental medicine',
      'doctor of dental medicine',
    ],
    offeredAs: ['dentistry', 'dental medicine'],
    note: 'Dentists take a Doctor of Dental Medicine degree and then the PRC Dentist Licensure Examination.',
    nearest: ['BS Nursing', 'BS Pharmacy'],
  },
  {
    name: 'Veterinary Medicine',
    forms: [
      'veterinarian',
      'veterinarians',
      'veterinary',
      'veterinary medicine',
      'doctor of veterinary medicine',
      'vet med',
      'beterinaryo',
    ],
    offeredAs: ['veterinary'],
    note: 'Veterinarians take a Doctor of Veterinary Medicine degree and then the PRC Veterinarian Licensure Examination.',
    nearest: ['BS Agriculture', 'BS Fisheries'],
  },
  {
    name: 'Medical Technology (Medical Laboratory Science)',
    forms: [
      'medical technology',
      'medical technologist',
      'medical technologists',
      'medtech',
      'med tech',
      'medical laboratory science',
      'medical laboratory scientist',
      'medical laboratory',
      'medical lab',
    ],
    offeredAs: ['medical technology', 'medical laboratory'],
    note: 'Medical Technology, also called Medical Laboratory Science, is a bachelor’s program with its own PRC licensure examination.',
    nearest: ['BS Nursing', 'BS Pharmacy'],
  },
  {
    name: 'Radiologic Technology',
    forms: [
      'radiologic technology',
      'radiologic technologist',
      'radtech',
      'rad tech',
      'radiographer',
      'radiology',
      'x ray technician',
      'xray technician',
    ],
    offeredAs: ['radiologic'],
    note: 'Radiologic Technology is a bachelor’s program with its own PRC licensure examination.',
    nearest: ['BS Nursing', 'BS Physical Therapy'],
  },
  {
    name: 'pilot training or an aviation program',
    forms: ['pilot', 'pilots', 'piloto', 'airline pilot', 'aviation', 'flight school'],
    offeredAs: ['aviation', 'flight', 'air transportation'],
    note: 'Pilots train at flight schools accredited by the Civil Aviation Authority of the Philippines (CAAP).',
    nearest: [],
  },
  {
    name: 'Aeronautical Engineering or Aircraft Maintenance',
    forms: [
      'aeronautical engineering',
      'aeronautical engineer',
      'aerospace engineering',
      'aircraft maintenance',
      'aircraft maintenance technology',
      'aircraft mechanic',
    ],
    offeredAs: ['aeronautical', 'aircraft'],
    note: 'These are specialised programs, and aircraft maintenance work is licensed by the Civil Aviation Authority of the Philippines (CAAP).',
    nearest: ['BS Mechanical Engineering', 'BS Electronics Technology'],
  },
  {
    name: 'Culinary Arts',
    forms: [
      'culinary',
      'culinary arts',
      'chef',
      'chefs',
      'pastry chef',
      'cook',
      'cooks',
      'cooking',
      'kusinero',
      'kusinera',
      'baker',
      'baking',
    ],
    offeredAs: ['culinary', 'cookery'],
    note: 'Cooking is usually studied through a hospitality program or a TESDA course.',
    nearest: ['BS Hospitality Management', 'BS Food Technology'],
  },
  {
    name: 'Social Work',
    forms: ['social work', 'social worker', 'social workers'],
    offeredAs: ['social work'],
    note: 'Social Work is a bachelor’s program with its own PRC licensure examination.',
    nearest: ['BS Psychology', 'Bachelor of Public Administration'],
  },
  {
    name: 'Customs Administration',
    forms: ['customs administration', 'customs broker', 'customs brokers'],
    offeredAs: ['customs'],
    note: 'Customs brokers take a Customs Administration degree and then the PRC Customs Broker Licensure Examination.',
    nearest: ['BS Business Administration'],
  },
  {
    name: 'Communication or Broadcasting',
    forms: [
      'mass communication',
      'mass comm',
      'mass com',
      'masscom',
      'communication arts',
      'development communication',
      'devcom',
      'broadcasting',
      'broadcast journalism',
    ],
    offeredAs: ['communication', 'journalism', 'broadcasting'],
    note: 'Journalism and broadcasting are not licensed professions, so graduates of many programs work in media.',
    nearest: ['AB English Language'],
  },
];
