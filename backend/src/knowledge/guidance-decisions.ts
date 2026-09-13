import type { GuidanceEntry } from '@/knowledge/guidance';

/**
 * Decision-making and next-step guidance (AI-COVERAGE-PLAN.md Phase 3, topics 6–12): choosing,
 * plan B, public and private colleges, admissions, financing, reading pay and demand, and what the
 * assistant itself can do.
 *
 * Every school-specific or time-sensitive fact — a fee, a deadline, a cut-off grade — is left out on
 * purpose and pointed at the counselor or the college. Those are what admin Q&A entries are for.
 */
export const DECISION_GUIDANCE: GuidanceEntry[] = [
  {
    slug: 'choosing-between-programs',
    title: 'Guide: Choosing between two programs',
    body: `How to choose between two programs using your results.
Start with the scores' components, not just the totals. If one program is higher because of RIASEC fit, it matches what you enjoy. If it is higher because of academic fit or strand alignment, it matches your preparation. A choice that fits both is strongest.
Then compare the careers each program leads to: their typical pay, their employment outlook, and whether their daily work sounds like you. Ask the assistant "what careers come after" each program.
Practical questions matter too: which colleges near you offer it, how long it takes, whether it has a board exam, and what it costs your family. Talk to someone who studied or works in the field if you can.
The decision is yours. Your match scores are a guide based on your answers, not a prediction. Your guidance counselor can help you weigh the trade-offs.`,
  },
  {
    slug: 'plan-b-first-choice-out-of-reach',
    title: 'Guide: If your first choice is out of reach',
    body: `If your first-choice program is out of reach — because of grades, strand, cost, distance or an entrance exam — you still have good options.
Look for programs that lead to the same careers. Many careers can be reached from more than one program: for example, Financial Analyst is linked to BS Accountancy, BS Accounting Information Systems and BS Business Administration. Ask the assistant which programs lead to a career you want.
Consider the same program at a different college, including a state university campus or a local college nearer to home, which may cost less.
If your grades in a key subject are low, bridging or review classes, or a related program with a lighter load, can be a path in. Some students start in one program and shift after the first year, subject to the college's rules.
Your second and third matches are real options, not failures. Talk to your guidance counselor before deciding.`,
  },
  {
    slug: 'public-private-colleges-bohol',
    title: 'Guide: Public and private colleges in Bohol',
    body: `Public and private colleges in Bohol.
Bohol Island State University (BISU) is a state university with campuses in Tagbilaran City (Main), Balilihan, Bilar, Calape, Candijay and Clarin. Local colleges run by a city or town — for example Tagbilaran City College and Trinidad Municipal College — are also public. Most other colleges in the catalog, such as Holy Name University and the University of Bohol, are private.
Under the Universal Access to Quality Tertiary Education Act, eligible Filipino students in state universities and in local colleges recognised by CHED do not pay tuition for their first bachelor's degree, though other fees and entrance requirements can apply. Private colleges charge tuition but often offer their own scholarships and discounts.
Fees, requirements and slots change every year. Ask your guidance counselor or the college's admissions office for current figures before deciding.`,
  },
  {
    slug: 'college-admissions-basics',
    title: 'Guide: Applying to college — the basics',
    body: `Applying to college: what a Grade 12 student should prepare.
Most colleges ask for a completed application form, your Grade 11 and Grade 12 report cards (Form 138), a certificate of good moral character, a birth certificate, and ID photos. Many also give an entrance or admission test, and some programs add an interview or a medical and physical check — especially Nursing, Criminology and the maritime programs.
Application usually opens during Grade 12, and state universities often fill their slots early, so apply to more than one college.
Keep your grades up in the subjects your program needs, since some programs set a minimum grade.
Every college sets its own requirements and dates. Check each college's official announcements, and ask your guidance counselor for the current schedule.`,
  },
  {
    slug: 'financing-and-scholarships',
    title: 'Guide: Paying for college and scholarships',
    body: `Ways to pay for college in the Philippines.
Free tuition: eligible students in state universities such as BISU, and in CHED-recognised local colleges, pay no tuition for their first bachelor's degree under the free higher education law.
Scholarships to ask about: DOST-SEI undergraduate scholarships for science, technology, engineering and mathematics programs; CHED scholarship and grant programs; scholarships from your provincial, city or municipal government; and the college's own academic, athletic and financial-need scholarships. Private companies and foundations also offer some.
Most scholarships look at grades and family income and have their own application periods, often during Grade 12. Some require you to take a qualifying exam.
Amounts, requirements and deadlines change every year. Your guidance counselor and the college's scholarship office have the current list.`,
  },
  {
    slug: 'reading-salary-and-outlook',
    title: 'Guide: Reading salary and job outlook',
    body: `How to read the salary and outlook shown for each career.
Salaries in CareerLinkAI are typical monthly ranges in Philippine pesos, from entry level at the low end to experienced or senior roles at the high end. A new graduate usually starts near the bottom of the range. Pay also depends on where you work, the employer, and whether you are licensed.
Employment outlook is one of four labels: Low Demand, Moderate Demand, High Demand, or Emerging Field. High Demand means employers are actively looking for people with this training. Emerging Field means a newer area that is growing, where opportunities are increasing but paths are less settled.
Neither number is a promise. Use them to compare careers, alongside what you enjoy and what you are confident you can do.`,
  },
  {
    slug: 'what-subjects-to-focus-on',
    title: 'Guide: Which subjects to focus on',
    body: `Which senior high school subjects to focus on for your chosen field.
Engineering, architecture, computing and maritime programs: Mathematics (General Mathematics, Pre-Calculus, Basic Calculus, Statistics) and Physics.
Health sciences, agriculture, fisheries and environment: Biology and Chemistry.
Business and accountancy: Mathematics and Statistics, and English for writing.
Education, law, political science, English, tourism and hospitality: English, oral communication, and reading and writing.
Your profile's Math, Science and English grades count for 20% of every program score through academic fit. Improving the subject your program depends on most helps both your score here and your college application.`,
  },
  {
    slug: 'board-exams',
    title: 'Guide: What a board exam is',
    body: `A board exam, or licensure examination, is the test you must pass after graduating to practise a regulated profession in the Philippines. Most are given by the Professional Regulation Commission (PRC).
Programs in the catalog that lead to a PRC board exam include Accountancy (CPA), Elementary, Secondary and Physical Education (LET for teachers), Nursing, Midwifery, Pharmacy, Physical Therapy, Psychology (Psychometrician), Criminology, Civil, Electrical, Mechanical and Agricultural and Biosystems Engineering, Architecture, Agriculture, Fisheries, Forestry and Food Technology. Juris Doctor graduates take the Bar Examination instead, and maritime graduates take licensure through MARINA.
Programs such as IT, Computer Science, Business Administration, Tourism and Hospitality have no board exam.
Many review for several months after graduation. A college's board passing rate is worth asking about when you choose.`,
  },
  {
    slug: 'about-the-assistant',
    title: 'Guide: What this assistant can and cannot do',
    body: `What the CareerLinkAI assistant can help with: your own results — your Holland code, RIASEC and SCCT scores, and why each career or program is on your list; the college catalog for Bohol — where each college is, what it offers, which colleges offer a program, and which careers a program leads to; career facts — typical monthly pay, outlook and what the work involves; and general guidance about scoring, strands, program families, board exams, admissions and scholarships.
What it cannot do: it does not change your scores or choose for you, it cannot see tuition fees, deadlines or entrance requirements unless your school has added them, and it does not know about colleges outside the catalog.
When it does not have an answer, it says so and you can ask for the answer to be added. Your guidance counselor is always the right person for personal decisions.`,
  },
];
