// Copyright (c) 2026 Alkhatim Muhammed. All rights reserved.

class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}

function toUserMessage(error, log) {
  if (error instanceof UserError) return error.message;
  if (log) log.error({ err: error }, 'Unexpected error');
  return 'Something went wrong. Please try again.';
}

module.exports = { UserError, toUserMessage };
