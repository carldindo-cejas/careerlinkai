import type { GuidanceEntry } from '@/knowledge/guidance';

/**
 * Guidance about the student's own results: how the score is built, what RIASEC and SCCT mean, and
 * how strands are treated (AI-COVERAGE-PLAN.md Phase 3, topics 1–4).
 *
 * Every entry is one retrievable passage — kept under the chunker's ~1,680-character ceiling so a
 * topic is never split across two chunks. The numbers in the scoring entries are the constants in
 * `lib/recommendation.ts`; if those change, change these too (a test pins the weights).
 */
export const RESULTS_GUIDANCE: GuidanceEntry[] = [
  {
    slug: 'how-match-scores-work',
    title: 'Guide: How your match score is built',
    body: `How CareerLinkAI builds a match score. Every score on your recommendations page is arithmetic, not an AI opinion, and the same answers always give the same score.
A career match adds up three parts: how well your RIASEC interests fit the career's typical interest code (60%), your SCCT career confidence (30%), and a fixed preference term (10%) that is the same for everyone.
A program match adds up five parts: RIASEC fit averaged over all the careers the program leads to (35%), career alignment with your own recommended careers (25%), SCCT career confidence (20%), academic fit from your Math, Science and English grades (10%), and strand alignment (10%).
Career alignment is the part that ties the two lists together: it scores the best careers a program leads to on exactly the same scale as your career list, so a program that leads to your top careers is pulled up even when its strand or its other careers do not suit you.
That is why a program can still rank differently from the careers it leads to: your grades and your strand add points that interests alone do not. It is also why two programs with the same name rank the same at different colleges.
A blank field is never a penalty. With no grades, academic fit counts as a neutral 60. With no strand, strand alignment counts as 70. Filling in your profile makes the program scores more precise.`,
  },
  {
    slug: 'riasec-overview',
    title: 'Guide: What RIASEC and your Holland code mean',
    body: `RIASEC is John Holland's model of six interest types: Realistic, Investigative, Artistic, Social, Enterprising and Conventional. The RIASEC assessment measures how much each type sounds like you, as a score from 0 to 100 with a band from Very Low to Very High.
Your Holland code is your three highest types, strongest first — for example CEI means Conventional, then Enterprising, then Investigative. Careers have codes too, and a career fits you best when its first letter is one of your strongest types.
The code describes what you enjoy, not what you are able to do. A low score in a type does not mean you would fail at that work; it means those activities appeal to you less right now. Interests can change as you try new things.
Use your code as a starting point for exploring careers, and look at your top two or three types together rather than only the first.`,
  },
  {
    slug: 'riasec-realistic',
    title: 'Guide: The Realistic type (R)',
    body: `Realistic (R) people like hands-on, practical work with tools, machines, plants, animals or the outdoors. They prefer doing and building to talking about ideas, and they like seeing a concrete result.
Typical activities: fixing and assembling things, operating equipment, farming, working on ships, building structures, working outdoors, physical and technical tasks.
Careers in this catalog that start with R include Civil Engineer, Electrical Engineer, Mechanical Engineer, Marine Engineer, Deck Officer, Agricultural and Biosystems Engineer, Agriculturist, Forester, Farm Operations Manager, Electronics Technician, Maintenance Engineer, Power Plant Engineer, Police Officer, Fire Officer and Registered Criminologist.
Programs that lead there include the engineering programs, BS Marine Engineering, BS Marine Transportation, BS Agriculture, BS Forestry, BS Industrial Technology and BS Criminology.`,
  },
  {
    slug: 'riasec-investigative',
    title: 'Guide: The Investigative type (I)',
    body: `Investigative (I) people like to observe, analyse and solve problems. They are curious, enjoy science and mathematics, and like understanding how and why things work before acting.
Typical activities: experiments, research, working with data, diagnosing problems, programming, reading and reasoning through complex questions.
Careers in this catalog that start with I include Software Developer, Data Scientist, Data Analyst, Computer Engineer, Cybersecurity Analyst, Environmental Scientist, Marine Biologist, Food Technologist, Pharmacist, Clinical Psychologist, Psychometrician, Clinical Researcher, Crime Scene Investigator and Legal Researcher.
Programs that lead there include BS Computer Science, BS Computer Engineering, BS Environmental Science, BS Marine Biology, BS Food Technology, BS Pharmacy and BS Psychology.`,
  },
  {
    slug: 'riasec-artistic',
    title: 'Guide: The Artistic type (A)',
    body: `Artistic (A) people like to create, design and express ideas. They value originality, enjoy unstructured work, and like writing, drawing, music, performance or visual design.
Typical activities: designing, drawing, writing, editing, making media, planning spaces and products, communicating ideas to an audience.
Careers in this catalog that start with A include Architect, Interior Designer, Industrial Designer, Graphic Designer, Multimedia Artist, UI/UX Designer, Journalist, Content Writer and Editor, Communications Officer and Curriculum Developer.
Programs that lead there include BS Architecture, BS Industrial Design and AB English Language. An Artistic student can also do well in programs whose careers mix creativity with another type, such as Architect (AIR) or UI/UX Designer (AIE).`,
  },
  {
    slug: 'riasec-social',
    title: 'Guide: The Social type (S)',
    body: `Social (S) people like helping, teaching, caring for and working with people. They are patient, good listeners, and find meaning in making a difference in someone's life.
Typical activities: teaching, nursing, counselling, coaching, community work, explaining things and supporting others.
Careers in this catalog that start with S include Elementary School Teacher, Secondary School Teacher, Physical Education Teacher, Guidance Counselor, School Administrator, Registered Nurse, Public Health Nurse, Nurse Administrator, Midwife, Physical Therapist, Public Health Officer, Sports Rehabilitation Specialist, Athletic Coach and Human Resources Specialist.
Programs that lead there include Bachelor of Elementary Education, Bachelor of Secondary Education, Bachelor of Physical Education, BS Nursing, BS Midwifery, BS Physical Therapy and BS Psychology.`,
  },
  {
    slug: 'riasec-enterprising',
    title: 'Guide: The Enterprising type (E)',
    body: `Enterprising (E) people like to lead, persuade, sell and start things. They are energetic, confident with people, and enjoy taking risks to reach a goal.
Typical activities: managing projects and teams, selling, negotiating, running a business, organising events, public speaking and making decisions.
Careers in this catalog that start with E include Entrepreneur, Operations Manager, Business Development Specialist, Marketing Specialist, Events Manager, Hotel Operations Manager, Tour Operations Manager, Tourism Officer, Public Administration Officer, Construction Project Manager, Port Operations Supervisor, Medical Sales Representative and Lawyer.
Programs that lead there include BS Business Administration, BS Entrepreneurship, BS Hospitality Management, BS Tourism Management, Bachelor of Public Administration, AB Political Science and Juris Doctor.`,
  },
  {
    slug: 'riasec-conventional',
    title: 'Guide: The Conventional type (C)',
    body: `Conventional (C) people like order, accuracy and clear procedures. They are organised, careful with details, and comfortable with numbers, records and systems.
Typical activities: bookkeeping and accounting, keeping records, checking for errors, organising data, following and improving procedures, office administration.
Careers in this catalog that start with C include Certified Public Accountant, Financial Analyst, Internal Auditor, Tax Advisory Specialist, Business Systems Analyst, Database Administrator, Systems Administrator, IT Support Specialist, Quality Assurance Engineer, Quantity Surveyor, Supply Chain Analyst, Bank Operations Officer, Office Administrator, Executive Assistant and Regulatory Affairs Specialist.
Programs that lead there include BS Accountancy, BS Accounting Information Systems, BS Information Systems, BS Information Technology, BS Office Administration and BS Business Administration.`,
  },
  {
    slug: 'scct-overview',
    title: 'Guide: What SCCT career confidence means',
    body: `SCCT is Social Cognitive Career Theory. The SCCT assessment measures three beliefs that research links to career choices: Self-Efficacy (believing you can succeed at the tasks a career needs), Outcome Expectations (believing that effort will lead to good results), and Goal Orientation (intending to pursue a career goal).
Each is scored from 0 to 100, and together they make your career confidence index, banded from Very Low to Very High. The index counts for 30% of every career match and 20% of every program match.
A low score is not a verdict on your ability. Confidence grows from experience: trying a subject or activity and succeeding at small steps, watching someone like you succeed, encouragement from teachers and family, and learning to manage worry. Joining a club, a short course, job shadowing or talking with someone who works in the field are practical ways to build it.
If your interests are high but your confidence is low for a field, that is worth discussing with your guidance counselor.`,
  },
  {
    slug: 'strands-and-programs',
    title: 'Guide: Senior high school strands and college programs',
    body: `CareerLinkAI records your senior high school strand as Academic or Technical-Professional, matching the two tracks of the strengthened senior high school curriculum. Some college programs list a recommended strand.
How it affects a program score: strand alignment is 100 when your strand matches the program's recommended strand, 40 when it does not, and 70 when your strand or the program's is unknown. A program with no recommended strand counts as aligned. Strand alignment is 10% of a program score.
A mismatch is advice, not a bar. Colleges generally admit students from any senior high school track, although some may ask for bridging subjects or look closely at your grades in Math and Science for technical programs.
If a program you want does not match your strand, ask your guidance counselor and the college's admissions office what they require. Update your strand on your profile if it is wrong, then rebuild your recommendations.`,
  },
];
