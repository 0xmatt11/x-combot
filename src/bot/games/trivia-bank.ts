/**
 * Trivia questions tagged by tier. Easy is everyday facts. Each step up
 * asks for more specific knowledge, so a higher tier is not the same list
 * with a different label.
 *
 * 1 Easy — everyday facts
 * 2 Medium — school knowledge
 * 3 Hard — solid general knowledge
 * 4 Expert — a well-read adult
 * 5 Master — specialist facts
 * 6 Insane — precise constants, dates, and niche results
 */
export const TRIVIA_DIFFICULTIES = [
  { id: "easy", label: "Easy", rank: 1 },
  { id: "medium", label: "Medium", rank: 2 },
  { id: "hard", label: "Hard", rank: 3 },
  { id: "expert", label: "Expert", rank: 4 },
  { id: "master", label: "Master", rank: 5 },
  { id: "insane", label: "Insane", rank: 6 },
] as const;

export type TriviaDifficulty = (typeof TRIVIA_DIFFICULTIES)[number]["id"];

export type TriviaQuestion = {
  prompt: string;
  choices: readonly [string, string, string, string];
  answer: 0 | 1 | 2 | 3;
  difficulty: TriviaDifficulty;
};

/** Names, the short alias `med`, and digits 1–6. */
export const TRIVIA_DIFFICULTY_WORDS: Readonly<Record<string, TriviaDifficulty>> = {
  "1": "easy",
  easy: "easy",
  "2": "medium",
  medium: "medium",
  med: "medium",
  "3": "hard",
  hard: "hard",
  "4": "expert",
  expert: "expert",
  "5": "master",
  master: "master",
  "6": "insane",
  insane: "insane",
};

const BY_RANK = new Map<number, TriviaDifficulty>(
  TRIVIA_DIFFICULTIES.map((row) => [row.rank, row.id]),
);
const BY_ID = new Map<TriviaDifficulty, string>(
  TRIVIA_DIFFICULTIES.map((row) => [row.id, row.label]),
);

export function triviaDifficultyByRank(rank: number): TriviaDifficulty | undefined {
  return BY_RANK.get(rank);
}

export function triviaDifficultyLabel(id: TriviaDifficulty): string {
  return BY_ID.get(id) ?? id;
}

export const TRIVIA_QUESTIONS: readonly TriviaQuestion[] = [
  { difficulty: "easy", prompt: "How many sides does a standard die have?", choices: ["4", "6", "8", "12"], answer: 1 },
  { difficulty: "easy", prompt: "What is 2 + 2?", choices: ["3", "4", "5", "22"], answer: 1 },
  { difficulty: "easy", prompt: "Which planet is closest to the sun?", choices: ["Venus", "Mars", "Mercury", "Earth"], answer: 2 },
  { difficulty: "easy", prompt: "How many minutes are in an hour?", choices: ["30", "60", "90", "100"], answer: 1 },
  { difficulty: "easy", prompt: "What color is a clear daytime sky?", choices: ["Green", "Blue", "Red", "Yellow"], answer: 1 },
  { difficulty: "easy", prompt: "How many letters are in the English alphabet?", choices: ["24", "25", "26", "27"], answer: 2 },
  { difficulty: "easy", prompt: "Which month has 28 days in a common year?", choices: ["January", "February", "April", "June"], answer: 1 },
  { difficulty: "easy", prompt: "What is the boiling point of water in Celsius?", choices: ["0", "32", "100", "212"], answer: 2 },
  { difficulty: "easy", prompt: "How many degrees are in a right angle?", choices: ["45", "90", "180", "360"], answer: 1 },
  { difficulty: "easy", prompt: "Which animal says meow?", choices: ["Dog", "Cow", "Cat", "Duck"], answer: 2 },
  { difficulty: "easy", prompt: "What is the capital of France?", choices: ["Lyon", "Paris", "Nice", "Lille"], answer: 1 },
  { difficulty: "easy", prompt: "How many cards are in a standard deck?", choices: ["36", "48", "52", "54"], answer: 2 },
  { difficulty: "easy", prompt: "Which way does a compass needle point?", choices: ["South", "East", "West", "North"], answer: 3 },
  { difficulty: "easy", prompt: "What is 10 × 10?", choices: ["20", "100", "1000", "110"], answer: 1 },
  { difficulty: "easy", prompt: "How many wheels does a bicycle have?", choices: ["1", "2", "3", "4"], answer: 1 },
  {
    difficulty: "easy",
    prompt: "Which gas do plants take in for photosynthesis?",
    choices: ["Oxygen", "Nitrogen", "Carbon dioxide", "Helium"],
    answer: 2,
  },

  { difficulty: "medium", prompt: "What is the largest planet in the solar system?", choices: ["Saturn", "Jupiter", "Neptune", "Uranus"], answer: 1 },
  { difficulty: "medium", prompt: "How many continents are usually counted?", choices: ["5", "6", "7", "8"], answer: 2 },
  { difficulty: "medium", prompt: "What is the chemical symbol for gold?", choices: ["Ag", "Au", "Fe", "Pb"], answer: 1 },
  { difficulty: "medium", prompt: "Who wrote Romeo and Juliet?", choices: ["Charles Dickens", "William Shakespeare", "Jane Austen", "Mark Twain"], answer: 1 },
  { difficulty: "medium", prompt: "What is the capital of Japan?", choices: ["Seoul", "Beijing", "Tokyo", "Kyoto"], answer: 2 },
  { difficulty: "medium", prompt: "How many strings does a standard violin have?", choices: ["3", "4", "5", "6"], answer: 1 },
  { difficulty: "medium", prompt: "Which ocean is the largest?", choices: ["Atlantic", "Indian", "Arctic", "Pacific"], answer: 3 },
  { difficulty: "medium", prompt: "Which gas do humans need from the air to live?", choices: ["Helium", "Oxygen", "Neon", "Hydrogen"], answer: 1 },
  { difficulty: "medium", prompt: "How many legs does a spider have?", choices: ["6", "8", "10", "12"], answer: 1 },
  { difficulty: "medium", prompt: "What is the square root of 81?", choices: ["7", "8", "9", "11"], answer: 2 },
  { difficulty: "medium", prompt: "Which country is home to the Great Wall?", choices: ["India", "China", "Japan", "Mongolia"], answer: 1 },
  { difficulty: "medium", prompt: "What is H2O?", choices: ["Salt", "Water", "Oxygen gas", "Hydrogen peroxide"], answer: 1 },

  { difficulty: "hard", prompt: "What is the powerhouse of the cell?", choices: ["Nucleus", "Ribosome", "Mitochondrion", "Golgi apparatus"], answer: 2 },
  { difficulty: "hard", prompt: "Which planet is known for its prominent ring system?", choices: ["Mars", "Venus", "Mercury", "Saturn"], answer: 3 },
  { difficulty: "hard", prompt: "What is the capital of Canada?", choices: ["Toronto", "Vancouver", "Ottawa", "Montreal"], answer: 2 },
  { difficulty: "hard", prompt: "Who painted the Mona Lisa?", choices: ["Michelangelo", "Raphael", "Leonardo da Vinci", "Donatello"], answer: 2 },
  { difficulty: "hard", prompt: "What is the hardest natural substance on the Mohs scale?", choices: ["Quartz", "Diamond", "Granite", "Steel"], answer: 1 },
  { difficulty: "hard", prompt: "How many elements does the periodic table currently recognize?", choices: ["92", "108", "118", "126"], answer: 2 },
  { difficulty: "hard", prompt: "Which country has the city of Marrakech?", choices: ["Egypt", "Morocco", "Tunisia", "Spain"], answer: 1 },
  { difficulty: "hard", prompt: "What is the speed of light in a vacuum, approximately?", choices: ["3×10^6 m/s", "3×10^8 m/s", "3×10^10 m/s", "3×10^5 m/s"], answer: 1 },
  { difficulty: "hard", prompt: "Who published the theory of general relativity?", choices: ["Isaac Newton", "Albert Einstein", "Niels Bohr", "Stephen Hawking"], answer: 1 },
  { difficulty: "hard", prompt: "What is the largest bone in the human body?", choices: ["Femur", "Tibia", "Humerus", "Pelvis"], answer: 0 },
  { difficulty: "hard", prompt: "Which language has the most native speakers?", choices: ["English", "Spanish", "Mandarin Chinese", "Hindi"], answer: 2 },
  { difficulty: "hard", prompt: "In what year did World War II end?", choices: ["1943", "1944", "1945", "1946"], answer: 2 },

  { difficulty: "expert", prompt: "What is the capital of Kazakhstan?", choices: ["Almaty", "Astana", "Tashkent", "Bishkek"], answer: 1 },
  { difficulty: "expert", prompt: "Which particle carries a negative electric charge?", choices: ["Proton", "Neutron", "Electron", "Photon"], answer: 2 },
  { difficulty: "expert", prompt: "What is the half-life of carbon-14, approximately?", choices: ["573 years", "5,730 years", "57,300 years", "573,000 years"], answer: 1 },
  { difficulty: "expert", prompt: "Who is traditionally credited with The Art of War?", choices: ["Confucius", "Sun Tzu", "Laozi", "Mencius"], answer: 1 },
  { difficulty: "expert", prompt: "What is the SI unit of electrical resistance?", choices: ["Volt", "Ampere", "Ohm", "Watt"], answer: 2 },
  { difficulty: "expert", prompt: "Which strait separates Europe and Africa at their closest point?", choices: ["Bering Strait", "Strait of Gibraltar", "Bosporus", "Strait of Malacca"], answer: 1 },
  { difficulty: "expert", prompt: "What is the most abundant gas in Earth's atmosphere?", choices: ["Oxygen", "Carbon dioxide", "Argon", "Nitrogen"], answer: 3 },
  { difficulty: "expert", prompt: "Who shares credit with Leibniz for inventing calculus?", choices: ["Leonhard Euler", "Isaac Newton", "Carl Gauss", "Euclid"], answer: 1 },
  { difficulty: "expert", prompt: "What is the atomic number of uranium?", choices: ["82", "88", "92", "94"], answer: 2 },
  { difficulty: "expert", prompt: "Which empire built Machu Picchu?", choices: ["Aztec", "Maya", "Inca", "Olmec"], answer: 2 },
  { difficulty: "expert", prompt: "What is the deepest known ocean trench?", choices: ["Mariana Trench", "Puerto Rico Trench", "Java Trench", "Tonga Trench"], answer: 0 },
  { difficulty: "expert", prompt: "What is Avogadro's number, approximately?", choices: ["6.022×10^23", "6.022×10^22", "3.14×10^23", "9.81×10^23"], answer: 0 },

  { difficulty: "master", prompt: "Which letter does not appear in the name of any U.S. state?", choices: ["J", "Q", "X", "Z"], answer: 1 },
  { difficulty: "master", prompt: "Who composed the Brandenburg Concertos?", choices: ["Johann Sebastian Bach", "George Frideric Handel", "Antonio Vivaldi", "Wolfgang Amadeus Mozart"], answer: 0 },
  { difficulty: "master", prompt: "What is the currency of Vietnam?", choices: ["Baht", "Dong", "Rupiah", "Ringgit"], answer: 1 },
  { difficulty: "master", prompt: "Which element has the chemical symbol W?", choices: ["Tungsten", "Tin", "Antimony", "Bismuth"], answer: 0 },
  { difficulty: "master", prompt: "In what year was Magna Carta sealed?", choices: ["1066", "1215", "1415", "1492"], answer: 1 },
  { difficulty: "master", prompt: "Which planet's day is longer than its year?", choices: ["Mercury", "Venus", "Mars", "Jupiter"], answer: 1 },
  { difficulty: "master", prompt: "What is the study of flags called?", choices: ["Vexillology", "Heraldry", "Semiotics", "Numismatics"], answer: 0 },
  { difficulty: "master", prompt: "Which of these bones is in the ear?", choices: ["Femur", "Stapes", "Patella", "Sacrum"], answer: 1 },
  { difficulty: "master", prompt: "What is the capital of Mongolia?", choices: ["Astana", "Ulaanbaatar", "Tashkent", "Kathmandu"], answer: 1 },
  { difficulty: "master", prompt: "Who proved Fermat's Last Theorem?", choices: ["Andrew Wiles", "Grigori Perelman", "Terence Tao", "Leonhard Euler"], answer: 0 },
  { difficulty: "master", prompt: "What is the molecular formula of glucose?", choices: ["C6H12O6", "C12H22O11", "CH4", "C2H5OH"], answer: 0 },
  { difficulty: "master", prompt: "Which war did the Peace of Westphalia end?", choices: ["The Thirty Years' War", "The Hundred Years' War", "The Wars of the Roses", "The Seven Years' War"], answer: 0 },

  { difficulty: "insane", prompt: "The fine-structure constant is approximately which fraction?", choices: ["1/137", "1/12", "1/273", "1/42"], answer: 0 },
  { difficulty: "insane", prompt: "The Chandrasekhar limit is about how many solar masses?", choices: ["0.7", "1.4", "2.8", "8"], answer: 1 },
  { difficulty: "insane", prompt: "A proton's diameter is on the order of how many meters?", choices: ["10^-10", "10^-15", "10^-18", "10^-21"], answer: 1 },
  { difficulty: "insane", prompt: "The Planck length is on the order of how many meters?", choices: ["10^-23", "10^-35", "10^-43", "10^-51"], answer: 1 },
  { difficulty: "insane", prompt: "Which amino acid does the codon AUG code for?", choices: ["Serine", "Methionine", "Tryptophan", "Glycine"], answer: 1 },
  { difficulty: "insane", prompt: "What is Earth's escape velocity from the surface, approximately?", choices: ["7.9 km/s", "11.2 km/s", "16.7 km/s", "25 km/s"], answer: 1 },
  { difficulty: "insane", prompt: "In what year was the Unicode Standard first published?", choices: ["1987", "1991", "1995", "2000"], answer: 1 },
  { difficulty: "insane", prompt: "Which play contains the line \"The quality of mercy is not strained\"?", choices: ["Hamlet", "Macbeth", "The Merchant of Venice", "Othello"], answer: 2 },
  { difficulty: "insane", prompt: "What is the genus of a torus?", choices: ["0", "1", "2", "3"], answer: 1 },
  { difficulty: "insane", prompt: "The first widely accepted proof of the four-color theorem depended on what?", choices: ["A computer-assisted check", "A new axiom of set theory", "Infinite descent", "A physical model"], answer: 0 },
  { difficulty: "insane", prompt: "Which constant is about 6.626×10^-34 joule-seconds?", choices: ["Planck's constant", "Boltzmann's constant", "Avogadro's number", "The gravitational constant"], answer: 0 },
  { difficulty: "insane", prompt: "What does the Riemann zeta function equal at s = 2?", choices: ["π^2/6", "π/6", "e^2", "π^2/8"], answer: 0 },
];
