// SINGLE SOURCE for all Arabic UI labels. No hardcoded Arabic literals in components.
export const ar = {
  nav: { home: "الرئيسية", journey: "الرحلة", settings: "الإعدادات" },
  home: { continue: "متابعة التعلّم", leaderboard: "المتصدّرون", wordOfDay: "كلمة اليوم" },
  common: { translate: "ترجمة", hint: "تلميح", retry: "إعادة المحاولة", next: "التالي" },
  journey: { wordsDone: "تم — أنهيت الكلمات", listening: "الاستماع", reading: "القراءة", conversation: "المحادثة", grammar: "القواعد" },
  // TODO: extend as screens are built.
} as const;
