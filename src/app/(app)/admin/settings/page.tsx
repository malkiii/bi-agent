import { requireUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';
import { listLlmModels } from './actions';
import { LlmForm } from './LlmForm';

export const dynamic = 'force-dynamic';

/** Admin: the active LLM provider and model. Access: src/proxy.ts plus `llmSettings` in the App Core. */
export default async function SettingsPage() {
  const me = await requireUser();
  const llm = await (await getCore()).llmSettings.get(me.slackUserId);
  const initialProvider = llm.active?.provider ?? llm.defaultProvider ?? llm.providers[0] ?? '';
  const initialModels = initialProvider ? await listLlmModels(initialProvider) : { models: [] };
  return (
    <section className="card">
      <h1>Settings</h1>
      <h2>Language model</h2>
      {llm.providers.length === 0 ? (
        <p>
          No LLM provider is configured. Add a provider&apos;s API key to <code>.env</code> (for example{' '}
          <code>ANTHROPIC_API_KEY</code>) and restart Botley.
        </p>
      ) : (
        <>
          <p>
            {llm.active
              ? `New Prompts use ${llm.labels[llm.active.provider] ?? llm.active.provider} ${llm.active.model}.`
              : 'No model is chosen yet, so Prompts fail until you choose one.'}{' '}
            Providers appear here once their API key (or server URL) is in <code>.env</code>.
          </p>
          <LlmForm providers={llm.providers} labels={llm.labels} active={llm.active} initialProvider={initialProvider} initialModels={initialModels} />
        </>
      )}
    </section>
  );
}
