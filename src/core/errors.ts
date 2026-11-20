/** Base class for errors the App Core raises on purpose; transports map them to responses. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The signed-in identity belongs to another Slack workspace. */
export class WrongWorkspaceError extends AppError {
  constructor() {
    super('wrong_workspace', 'This Slack workspace is not allowed to sign in.');
  }
}

/** The actor is not allowed to perform the action. */
export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do that.') {
    super('forbidden', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found.') {
    super('not_found', message);
  }
}

/** Demoting this admin would leave the workspace with no admins. */
export class LastAdminError extends AppError {
  constructor() {
    super('last_admin', 'The last admin cannot be demoted. Promote someone else first.');
  }
}
