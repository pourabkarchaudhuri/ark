/**
 * One-off test: call Azure OpenAI via LangChain (no Electron).
 * Run: node scripts/test-azure-openai.mjs
 * Requires .env with AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_KEY, AZURE_OPENAI_DEPLOYMENT.
 */
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '.env') });

const strip = (s) => (s || '').replace(/^[\s`'"]+|[\s`'"]+$/g, '').trim();
const endpoint = strip(process.env.AZURE_OPENAI_ENDPOINT || process.env.AZURE_OPENAI_API_ENDPOINT);
const apiKey = strip(process.env.AZURE_OPENAI_KEY || process.env.AZURE_OPENAI_API_KEY);
const deployment = strip(process.env.AZURE_OPENAI_DEPLOYMENT || process.env.AZURE_OPENAI_DEPLOYMENT_NAME);
const apiVersion = strip(process.env.AZURE_OPENAI_KEY_VERSION || process.env.AZURE_OPENAI_API_VERSION) || '2024-12-01-preview';

if (!endpoint || !apiKey || !deployment) {
  console.error('Missing AZURE_OPENAI_* in .env');
  process.exit(1);
}

const baseUrl = endpoint.replace(/\/+$/, '');
console.log('Calling Azure OpenAI:', baseUrl, 'deployment:', deployment);

const { AzureChatOpenAI } = await import('@langchain/openai');
const { HumanMessage } = await import('@langchain/core/messages');

const model = new AzureChatOpenAI({
  azureOpenAIEndpoint: baseUrl,
  azureOpenAIApiKey: apiKey,
  azureOpenAIApiDeploymentName: deployment,
  model: deployment, // so LangChain sends max_completion_tokens for gpt-5.x reasoning models
  azureOpenAIApiVersion: apiVersion,
  temperature: 0.7,
  maxCompletionTokens: 100,
});

try {
  const res = await model.invoke([new HumanMessage('Reply with exactly: OK')]);
  const text = typeof res.content === 'string' ? res.content : (Array.isArray(res.content) ? res.content.map(c => c.text || c).join('') : String(res.content));
  console.log('Response:', text);
  console.log('Done.');
} catch (err) {
  console.error('Error:', err.message || err);
  process.exit(1);
}
