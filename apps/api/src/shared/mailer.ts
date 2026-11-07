import type { Booking } from '@erc/contracts';
import type { FastifyBaseLogger } from 'fastify';

export interface BookingConfirmation {
  readonly to: string;
  readonly booking: Booking;
  /** Hanteringslänkens token i klartext. Finns bara här och i mejlet, aldrig i databasen. */
  readonly manageToken: string;
}

export interface LoginLink {
  readonly to: string;
  /** Engångstoken i klartext, giltig i 15 minuter. */
  readonly token: string;
}

/**
 * Utskick av e-post. Skickas efter commit, så att en bekräftelse aldrig går ut
 * för en bokning som rullades tillbaka. Fas 5 ersätter detta med en
 * transaktionell utkorg (docs/architecture.md).
 */
export interface Mailer {
  sendBookingConfirmation(message: BookingConfirmation): Promise<void>;
  sendLoginLink(message: LoginLink): Promise<void>;
}

/** Fångar meddelanden i minnet. Används av tester för att läsa hanteringslänken. */
export class InMemoryMailer implements Mailer {
  readonly sent: BookingConfirmation[] = [];
  readonly loginLinks: LoginLink[] = [];

  sendBookingConfirmation(message: BookingConfirmation): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  sendLoginLink(message: LoginLink): Promise<void> {
    this.loginLinks.push(message);
    return Promise.resolve();
  }

  lastTo(email: string): BookingConfirmation | undefined {
    return this.sent.findLast((message) => message.to === email);
  }
}

/**
 * Skriver utskicket till loggen tills riktig e-post finns. Token loggas bara när
 * revealTokens är satt (utveckling), eftersom den ger tillgång till bokningen.
 */
export function createLogMailer(
  getLog: () => FastifyBaseLogger,
  options: { readonly revealTokens: boolean },
): Mailer {
  return {
    sendBookingConfirmation(message) {
      getLog().info(
        {
          bookingId: message.booking.id,
          ...(options.revealTokens ? { manageToken: message.manageToken } : {}),
        },
        'booking confirmation (e-mail not configured)',
      );
      return Promise.resolve();
    },
    sendLoginLink(message) {
      getLog().info(
        options.revealTokens ? { loginToken: message.token } : {},
        'login link (e-mail not configured)',
      );
      return Promise.resolve();
    },
  };
}
