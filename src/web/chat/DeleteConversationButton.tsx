'use client';

import type { FormEvent } from 'react';
import { PendingButton } from '@/web/components/PendingButton';
import { deleteConversationAction } from './actions';

/** Deletes a Conversation for everyone after the person confirms. `back` is the current page. */
export function DeleteConversationButton({
  conversationId,
  back,
  className = 'btn btn--pink',
}: {
  conversationId: string;
  back: string;
  className?: string;
}) {
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    if (!window.confirm('Delete this chat for everyone in it? This cannot be undone.')) event.preventDefault();
  }
  return (
    <form action={deleteConversationAction} onSubmit={onSubmit}>
      <input type="hidden" name="conversationId" value={conversationId} />
      <input type="hidden" name="back" value={back} />
      <PendingButton className={className}>Delete</PendingButton>
    </form>
  );
}
