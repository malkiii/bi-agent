import { requireUser } from '@/web/current-user';
import { getCore } from '@/web/server-runtime';
import { LlmForm } from './LlmForm';

export const dynamic = 'force-dynamic';

/** Admin: the active LLM provider and model. Access: src/proxy.ts plus `llmSettings.get` in the App Core. */
export default async function LlmSettingsPage() {
  const me = await requireUser();
  const settings = await (await getCore()).llmSettings.get(me.slackUserId);
  const fallback = settings.default;
  return (
    <section className="card">
      <h1>LLM</h1>
      <p>
        Choose the provider and model for new Prompts, in the web app and in Slack. Only providers whose keys are set in
        the environment are listed.
      </p>
      {settings.providers.length === 0 ? (
        <p>No LLM provider is configured. Set LLM_PROVIDER, LLM_MODEL and the provider&apos;s key in the environment.</p>
      ) : (
        <>
          <p>
            Environment default:{' '}
            {fallback ? (
              <strong>
                {fallback.provider} / {fallback.model}
              </strong>
            ) : (
              'none'
            )}
            {settings.overridden && <span className="tag">overridden</span>}
          </p>
          <LlmForm key={`${settings.active?.provider}/${settings.active?.model}`} settings={settings} />
        </>
      )}
    </section>
  );
}
