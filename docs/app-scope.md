# App Scope — Arabic-first English Learning App

A scope document defining what the app includes: sections, features, rules, and the boundaries of this version.

> The app UI is entirely in Arabic (RTL). Arabic labels for on-screen text are shown in parentheses.

---

## 1. Overview

A mobile app for Arabic speakers learning English, with a fully Arabic, right-to-left (RTL) interface. It moves the user from *understanding* English to *speaking it with confidence*, through a learning journey split into units; each unit combines: words, listening, reading, conversation, and grammar.

**Identity:** "The app that understands your mistakes as an Arabic speaker and fixes them — your pronunciation, grammar, and speaking — and explains everything to you in Arabic."

---

## 2. Fundamentals

- **Platform:** Mobile app (iOS / Android), portrait screens.
- **Language:** Fully Arabic, RTL. English words and sentences appear LTR inside the Arabic layout.
- **Governing principle (most important):** **One purpose per screen.** Teaching is its own screen, a quiz is a separate screen, and each question type has its own dedicated screen. Never mix more than one purpose on a single screen. A progress indicator appears on every learning screen.
- **Design system:** clean light theme; primary color emerald/teal green; warm gold accent for points, streak, and rewards; warm-gray backgrounds; rounded cards; generous whitespace; large touch targets; Arabic font (Cairo/Tajawal) and English font (Inter).

---

## 3. Architecture & Navigation

A bottom navigation bar with **3 sections** (RTL): **Home (الرئيسية) · Journey (الرحلة) · Settings (الإعدادات)**.

---

## 4. Feature Scope

### 4.1 Auth & Onboarding
- Sign in / sign up.
- Short onboarding: name, age, native language (Arabic), goal (travel / work / study abroad / daily conversation).

### 4.2 Placement Test
- Questions, **one question per screen**.
- Determines the level (A1–C1) or "complete beginner".
- Complete beginner → Foundations stage. Otherwise → starts at the unit matching their level.

### 4.3 Foundations Stage (complete beginners only)
Combines BOTH:
- **Letters & sounds (phonics):** the English alphabet and its sounds.
- **Very simple words with extra Arabic support.**

Same one-screen-per-purpose rule. After it, the user enters the normal unit flow.

### 4.4 Home (الرئيسية)
A single screen containing:
- **Progress card:** number of words learned, streak (flame icon), current level, and a **"Continue learning" (متابعة التعلّم)** button that jumps to where the user stopped.
- **Word of the Day:** the English word + an audio/listen button + an example sentence below it + its Arabic translation.
- **Leaderboard (المتصدّرون):** top users by points (avatar, name, points).
- **Account summary:** name, avatar, level.

### 4.5 Journey (الرحلة) — the core learning section
A vertical list of **cards; each card = one Unit** (states: locked / current / completed).

**Unit flow (sequential, every screen separate):**

**A) The 5 words** — for each word, in order:
1. **Word teaching screen** (one word): the word (large, LTR) + phonetic spelling + audio/listen button + Arabic translation + an English example sentence with its translation.
2. **Word quiz — 3 separate screens:**
   - **Spelling:** type the English word.
   - **Pronunciation:** a record button; the user says the word; show a **score (0–100)** + highlight the mispronounced part + a retry button; must pass a threshold to continue.
   - **Meaning:** multiple choice — pick the correct Arabic meaning.
   - → then the next word.

**B) Full words quiz** — after all 5 words (each question on its own screen, mixed types).

**C) Completion screen:** "Done — words finished" (تم — أنهيت الكلمات), which unlocks Listening.

**D) Listening (الاستماع):** a set of audio clips, each on its own screen: a play button + a **"Translate" (ترجمة) button** that reveals the spoken text as written text + its Arabic translation + a comprehension question (each question on its own screen). **Clips must contain the unit's words.**

**E) Reading (القراءة):** an English passage + a **"Translate" (ترجمة) button** that toggles the Arabic translation + comprehension questions (each on its own screen) that make the learner think. **The passage must use the unit's words.**

**F) Conversation (المحادثة):** a 3-minute conversation with an AI tutor:
- The AI **starts** the conversation and **types** its messages (text).
- The user replies by **voice only (record button) — typing is not allowed.**
- A **"Hint" (تلميح) button** + a **translation reveal** for the AI messages.
- A **3-minute timer.**
- The user must use the unit's 5 words (an indicator shows which words have been used).
- A summary screen at the end.

**G) Grammar (القواعد):**
- A **grammar lesson screen**: the rule explained in Arabic, with English examples that use the unit's words (adapted to the user's level).
- A **grammar quiz** (each question on its own screen) that also includes the unit's words.

**H) Unit complete:** award XP + update streak + unlock the next unit.

### 4.6 Settings (الإعدادات)
Account, Arabic-support level, audio, notifications, sign out.

---

## 5. Cross-cutting Features

- **Audio:** only one audio source plays at any moment (no overlap); play buttons on words, examples, and listening.
- **Translation:** a unified pattern to reveal/hide the Arabic translation (listening, reading, conversation).
- **Pronunciation assessment:** score 0–100, highlight the mispronounced part, a pass threshold, and retry.
- **Gamification:** XP points, daily streak, leaderboard.
- **Progress & locking:** content unlocks sequentially (no skipping); auto-save of the user's position.
- **Level-based difficulty:** content and explanations adapt to the user's level.

---

## 6. Content Rules

- Each unit = **5 core words**.
- **Listening, reading, and conversation must use the unit's words** (to reinforce what was learned).
- Content and explanations are delivered **according to the user's level** (A1–C1).

---

## 7. Per-user Data (product level)

User profile (name/age/language/goal), level, words and their status, streak, XP, current position in the journey, quiz and pronunciation results, and leaderboard rank.

---

## 8. Out of Scope (for this version)

- A standalone **Writing** practice section — deferred to a later version.
- Offline mode.
- Admin dashboard.
- UI languages other than Arabic.
- Social features beyond the leaderboard.

---

## 9. Suggested Build Order

1. Structure & navigation + onboarding + placement test.
2. Journey: words (teaching + their quizzes), then the full words quiz.
3. Listening and reading (reusing the unit's words).
4. Voice conversation (3 minutes) + grammar.
5. Home (progress + word of the day + leaderboard) + settings.
6. Polish: advanced pronunciation assessment, gamification, notifications.
