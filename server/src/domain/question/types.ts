/** Domain types for questions — shared by grading, drill generation, question bank */

export type QuestionType = "fill_blank" | "choice" | "true_false";

export interface ChoiceOption {
  id: string;
  text: string;
}

export interface QuestionSnapshot {
  id?: string;
  type: QuestionType;
  stem: string;
  options: ChoiceOption[] | null;
  answer: string | boolean;
  explanation: string | null;
  knowledgeNodeId: string | null;
  source: "manual" | "generated";
}
