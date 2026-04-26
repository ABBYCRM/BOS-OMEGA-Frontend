import type { TaskType } from "./types.js";

interface ClassificationResult {
  task_type: TaskType;
  confidence: number;
  required_capabilities: string[];
}

const TASK_PATTERNS: Array<{
  type: TaskType;
  patterns: RegExp[];
  capabilities: string[];
  weight: number;
}> = [
  {
    type: "code",
    patterns: [
      /\b(code|function|program|script|debug|error|compile|implement|refactor|test|algorithm|api|class|method|bug|fix)\b/i,
      /```|<code>|\bpython\b|\bjavascript\b|\btypescript\b|\bjava\b|\bc\+\+\b|\brust\b|\bgo\b/i,
    ],
    capabilities: ["coding", "reasoning", "structured_output"],
    weight: 2,
  },
  {
    type: "legal",
    patterns: [
      /\b(legal|law|contract|liability|regulation|compliance|statute|attorney|court|plaintiff|defendant|intellectual property|patent|copyright|trademark|gdpr|hipaa)\b/i,
    ],
    capabilities: ["reasoning", "legal", "long_context"],
    weight: 2,
  },
  {
    type: "math",
    patterns: [
      /\b(calculate|compute|solve|equation|integral|derivative|algebra|calculus|statistics|probability|matrix|vector|proof)\b/i,
      /[\+\-\*\/\=\^]\s*\d+|\d+\s*[\+\-\*\/\=\^]/,
    ],
    capabilities: ["reasoning", "structured_output"],
    weight: 2,
  },
  {
    type: "research",
    patterns: [
      /\b(research|study|analyze|compare|evidence|literature|paper|findings|survey|review|investigate|sources)\b/i,
    ],
    capabilities: ["research", "long_context", "reasoning"],
    weight: 1.5,
  },
  {
    type: "summarization",
    patterns: [
      /\b(summarize|summary|tldr|overview|brief|condense|shorten|key points|main points)\b/i,
    ],
    capabilities: ["cheap", "fast", "long_context"],
    weight: 1.5,
  },
  {
    type: "extraction",
    patterns: [
      /\b(extract|parse|find all|identify|list all|pull out|get the|what are the)\b/i,
    ],
    capabilities: ["structured_output", "fast"],
    weight: 1.5,
  },
  {
    type: "planning",
    patterns: [
      /\b(plan|strategy|roadmap|steps|approach|how should|design|architecture|organize|prioritize|schedule)\b/i,
    ],
    capabilities: ["reasoning", "structured_output"],
    weight: 1.5,
  },
  {
    type: "creative",
    patterns: [
      /\b(write|create|generate|story|poem|essay|creative|imagine|compose|narrative|fiction|script|blog)\b/i,
    ],
    capabilities: ["fast", "cheap"],
    weight: 1,
  },
  {
    type: "safety_review",
    patterns: [
      /\b(safe|unsafe|appropriate|ethical|review|check|moderate|harmful|dangerous|risk|policy)\b/i,
    ],
    capabilities: ["safety", "reasoning"],
    weight: 2,
  },
];

export function classifyTask(input: string, intent_hint?: string): ClassificationResult {
  const scores: Map<TaskType, number> = new Map();
  const capabilities: Map<TaskType, string[]> = new Map();

  for (const config of TASK_PATTERNS) {
    let score = 0;
    for (const pattern of config.patterns) {
      if (pattern.test(input)) {
        score += config.weight;
      }
    }
    if (score > 0) {
      scores.set(config.type, (scores.get(config.type) || 0) + score);
      capabilities.set(config.type, config.capabilities);
    }
  }

  if (intent_hint) {
    const hint = intent_hint as TaskType;
    if (TASK_PATTERNS.find((p) => p.type === hint)) {
      scores.set(hint, (scores.get(hint) || 0) + 1.5);
    }
  }

  let bestType: TaskType = "general";
  let bestScore = 0;

  for (const [type, score] of scores.entries()) {
    if (score > bestScore) {
      bestScore = score;
      bestType = type;
    }
  }

  const totalScore = Array.from(scores.values()).reduce((a, b) => a + b, 0);
  const confidence = totalScore > 0 ? Math.min(bestScore / (totalScore * 0.7), 1) : 0.5;

  return {
    task_type: bestType,
    confidence,
    required_capabilities: capabilities.get(bestType) || ["reasoning", "fast"],
  };
}
