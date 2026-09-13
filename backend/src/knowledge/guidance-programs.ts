import type { GuidanceEntry } from '@/knowledge/guidance';

/**
 * Program families (AI-COVERAGE-PLAN.md Phase 3, topic 5) — one passage per family in the Bohol
 * catalog: what you study, the senior high school subjects that matter most, the licensure exam if
 * there is one, and who tends to thrive.
 *
 * Deliberately free of figures that change year to year — tuition, passing rates, exam dates. Those
 * belong in admin Q&A entries, where the school can keep them current. Program lengths are stated
 * only where they are well established; elsewhere the passage says to confirm with the college.
 */
export const PROGRAM_GUIDANCE: GuidanceEntry[] = [
  {
    slug: 'family-business-accountancy',
    title: 'Guide: Business and accountancy programs',
    body: `Business and accountancy programs in the catalog: BS Accountancy, BS Accounting Information Systems, BS Business Administration, BS Entrepreneurship and BS Office Administration.
What you study: accounting, auditing, taxation, business law, finance, management, marketing and economics. Accounting Information Systems adds databases and business computing.
Senior high school subjects that matter most: General Mathematics, Statistics and Probability, and English for reports and business writing. Business Mathematics and any accounting subject help.
Licensure: BS Accountancy graduates take the Licensure Examination for Certified Public Accountants given by the Professional Regulation Commission (PRC). Passing it is what makes you a CPA. The other business programs have no board exam.
Who thrives: students who are organised, careful with numbers and details (Conventional), or who like leading and selling (Enterprising). Accountancy is known for a heavy workload and strict retention rules at many schools, so ask the college about its policy.`,
  },
  {
    slug: 'family-it-computing',
    title: 'Guide: IT and computing programs',
    body: `IT and computing programs in the catalog: BS Information Technology, BS Computer Science, BS Information Systems and BS Computer Engineering.
What you study: programming, databases, networks, web and mobile development, systems analysis and cybersecurity. Computer Science goes deeper into algorithms and theory; Information Technology focuses on building and running systems; Information Systems connects computing to business; Computer Engineering adds electronics and hardware.
Senior high school subjects that matter most: General Mathematics, Statistics and Probability, and any computer programming or ICT subject. Computer Engineering also needs strong Physics and Pre-Calculus or Calculus.
Licensure: IT, Computer Science and Information Systems have no board exam; employers look at skills, projects and certifications. Computer Engineering is a regulated engineering profession.
Who thrives: students who like solving problems and learning on their own (Investigative), and those who like order and systems (Conventional). Practice outside class — building small projects — matters a great deal.`,
  },
  {
    slug: 'family-engineering',
    title: 'Guide: Engineering and architecture programs',
    body: `Engineering and design programs in the catalog: BS Civil Engineering, BS Electrical Engineering, BS Mechanical Engineering, BS Computer Engineering, BS Agricultural and Biosystems Engineering, BS Architecture and BS Industrial Design.
What you study: advanced mathematics, physics, mechanics, drafting and design, and the core of each discipline — structures and construction for Civil, power systems for Electrical, machines and thermal systems for Mechanical, buildings and space for Architecture.
Senior high school subjects that matter most: Pre-Calculus, Basic Calculus, General Physics and General Chemistry. Strong Math grades matter more here than in almost any other field. Architecture also values drawing and visual design.
Licensure: civil, electrical, mechanical and agricultural engineers, and architects, take PRC licensure examinations. BS Architecture usually takes five years, followed by required practical experience before the architecture board exam.
Who thrives: students with Realistic and Investigative interests who enjoy mathematics and building things. Architecture and Industrial Design suit students who also score high in Artistic.`,
  },
  {
    slug: 'family-education',
    title: 'Guide: Teacher education programs',
    body: `Teacher education programs in the catalog: Bachelor of Elementary Education (BEED), Bachelor of Secondary Education (BSED) and Bachelor of Physical Education (BPED).
What you study: child and adolescent development, teaching methods, assessment, curriculum, and the subject you will teach — BSED students choose a major such as English, Mathematics, Science or Filipino. Every program includes practice teaching in a real school.
Senior high school subjects that matter most: English and Filipino for communication, plus strong grades in the subject you want to teach. Physical Education needs good fitness and interest in sports.
Licensure: graduates take the Licensure Examination for Teachers (LET) given by the PRC. Passing it is required to teach in public schools.
Who thrives: Social students who are patient, enjoy explaining things and like working with young people. Teaching is one of the most widely offered programs in Bohol, so many colleges near you likely offer it.`,
  },
  {
    slug: 'family-health',
    title: 'Guide: Health science programs',
    body: `Health science programs in the catalog: BS Nursing, BS Midwifery, BS Pharmacy, BS Physical Therapy and BS Psychology.
What you study: anatomy, physiology, biochemistry and microbiology, then the practice of each field — patient care for Nursing, maternal and newborn care for Midwifery, medicines for Pharmacy, movement and rehabilitation for Physical Therapy, and behaviour and mental processes for Psychology. Most include hospital or clinical duty.
Senior high school subjects that matter most: General Biology and General Chemistry, plus English for patient communication. Pharmacy needs strong Chemistry.
Licensure: nurses, midwives, pharmacists and physical therapists take PRC licensure examinations. BS Psychology graduates can take the Psychometrician licensure exam; becoming a clinical psychologist requires graduate study.
Who thrives: Social students who care about people and stay calm under pressure, often with Investigative interests too. The work involves long shifts and responsibility for others' health, so it rewards commitment.`,
  },
  {
    slug: 'family-criminology',
    title: 'Guide: Criminology and public safety programs',
    body: `Criminology and public safety in the catalog: BS Criminology, offered at many colleges in Bohol, and Bachelor of Public Administration.
What you study in Criminology: criminal law and procedure, criminalistics (forensic science), crime detection and investigation, correctional administration, law enforcement administration and ethics, with physical training and an internship.
Senior high school subjects that matter most: English for reports and testimony, Science for forensic subjects, and good physical fitness.
Licensure: BS Criminology graduates take the Criminologist Licensure Examination given by the PRC. Many police, fire and jail officer paths also have their own entrance requirements, such as age, height and fitness standards and a civil service eligibility, so check the current rules of the agency you want.
Who thrives: Realistic and Social students who want to protect their community, handle stress well and like structure. Public Administration suits Enterprising students interested in government work.`,
  },
  {
    slug: 'family-hospitality-tourism',
    title: 'Guide: Hospitality and tourism programs',
    body: `Hospitality and tourism programs in the catalog: BS Hospitality Management and BS Tourism Management. Bohol's tourism industry, especially around Panglao and Tagbilaran, makes these some of the most offered programs in the province.
What you study: food and beverage service, kitchen operations, front office and housekeeping, events, tour and travel operations, tourism planning, customer service and business management, with on-the-job training in hotels, resorts or travel agencies.
Senior high school subjects that matter most: English and oral communication, plus any cookery, food and beverage, or tourism subject. A foreign language is a plus.
Licensure: there is no board exam. Employers value experience, National Certificates from TESDA, and communication skills.
Who thrives: Enterprising and Social students who enjoy people, can stay friendly under pressure, and do not mind weekend and holiday work.`,
  },
  {
    slug: 'family-agriculture-environment',
    title: 'Guide: Agriculture, fisheries and environment programs',
    body: `Agriculture and environment programs in the catalog: BS Agriculture, BS Agricultural and Biosystems Engineering, BS Fisheries, BS Forestry, BS Food Technology, BS Environmental Science and BS Marine Biology. Many are taught at Bohol Island State University campuses in Bilar, Calape, Candijay and Clarin.
What you study: crop and animal science, soils, aquaculture and fish processing, forest management, food processing and safety, ecology, and field and laboratory work.
Senior high school subjects that matter most: General Biology and General Chemistry, plus Earth and Life Science. Food Technology and Environmental Science need strong Chemistry.
Licensure: agriculturists, fisheries technologists, foresters, food technologists and agricultural and biosystems engineers take PRC licensure examinations.
Who thrives: Realistic and Investigative students who like being outdoors or in the lab and care about food, the sea and the environment. These fields matter in a farming and coastal province like Bohol.`,
  },
  {
    slug: 'family-maritime',
    title: 'Guide: Maritime programs',
    body: `Maritime programs in the catalog: BS Marine Transportation, which trains deck officers who navigate ships, and BS Marine Engineering, which trains engineers who run a ship's engines and machinery. Some colleges list them as BS Maritime Transportation and BS Maritime Engineering.
What you study: navigation, seamanship, ship stability, maritime law, marine engines and power plants, safety and survival training, followed by required shipboard training at sea.
Senior high school subjects that matter most: General Mathematics and General Physics, plus English, which is the working language at sea. Good health, eyesight and fitness are required, and schools check them.
Licensure: after shipboard training, graduates take the officer licensure examinations and certification administered through the Maritime Industry Authority (MARINA).
Who thrives: Realistic students who are disciplined, comfortable with long periods away from home, and able to work in a strict chain of command. Pay for licensed officers can be high, which is reflected in the catalog salaries.`,
  },
  {
    slug: 'family-law-politics-languages',
    title: 'Guide: Law, political science and language programs',
    body: `Programs in the catalog: AB Political Science, AB English Language and Juris Doctor.
AB Political Science studies government, public policy, law and international relations, and is a common pre-law program. AB English Language studies linguistics, literature and writing, and leads to writing, communications, publishing and teaching.
Juris Doctor is a graduate law degree: you enter it after finishing a bachelor's degree, and graduates take the Philippine Bar Examination to become lawyers. There is no required pre-law program, but Political Science, English and business programs are common routes.
Senior high school subjects that matter most: English and oral communication, reading and writing, and social sciences.
Who thrives: Enterprising, Artistic and Investigative students who enjoy reading, arguing a position, writing clearly and following public issues.`,
  },
];
