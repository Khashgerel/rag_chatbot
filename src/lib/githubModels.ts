import OpenAI from "openai";

export function getGitHubModelsClient() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Missing GITHUB_TOKEN in environment.");

  return new OpenAI({
    baseURL: "https://models.github.ai/inference",
    apiKey: token
  });
}
