import type { PrismaClient } from "@prisma/client";

import type { EventManagerUser } from "@calcom/core/EventManager";
import { sendAttendeeRequestEmail, sendOrganizerRequestEmail } from "@calcom/emails";
import getWebhooks from "@calcom/features/webhooks/lib/getWebhooks";
import type { EventTypeInfo } from "@calcom/features/webhooks/lib/sendPayload";
import sendPayload from "@calcom/features/webhooks/lib/sendPayload";
import logger from "@calcom/lib/logger";
import { WebhookTriggerEvents } from "@calcom/prisma/enums";
import type { CalendarEvent } from "@calcom/types/Calendar";

const log = logger.getChildLogger({ prefix: ["[handleConfirmation] book:user"] });

/**
 * Supposed to do whatever is needed when a booking is requested.
 */
export async function handleBookingRequested(args: {
  user: EventManagerUser & { username: string | null };
  evt: CalendarEvent;
  recurringEventId?: string;
  prisma: PrismaClient;
  bookingId: number;
  booking: {
    eventType: {
      currency: string;
      description: string | null;
      id: number;
      length: number;
      price: number;
      requiresConfirmation: boolean;
      title: string;
      teamId?: number | null;
    } | null;
    eventTypeId: number | null;
    smsReminderNumber: string | null;
    userId: number | null;
  };
  paid?: boolean;
}) {
  const { evt, bookingId, booking, paid } = args;

  await sendOrganizerRequestEmail({ ...evt });
  await sendAttendeeRequestEmail({ ...evt }, evt.attendees[0]);

  try {
    const subscribersBookingRequested = await getWebhooks({
      userId: booking.userId,
      eventTypeId: booking.eventTypeId,
      triggerEvent: WebhookTriggerEvents.BOOKING_REQUESTED,
      teamId: booking.eventType?.teamId,
    });

    const eventTypeInfo: EventTypeInfo = {
      eventTitle: booking.eventType?.title,
      eventDescription: booking.eventType?.description,
      requiresConfirmation: booking.eventType?.requiresConfirmation || null,
      price: booking.eventType?.price,
      currency: booking.eventType?.currency,
      length: booking.eventType?.length,
    };

    const promises = subscribersBookingRequested.map((sub) =>
      sendPayload(sub.secret, WebhookTriggerEvents.BOOKING_REQUESTED, new Date().toISOString(), sub, {
        ...evt,
        ...eventTypeInfo,
        bookingId,
      }).catch((e) => {
        console.error(
          `Error executing webhook for event: ${WebhookTriggerEvents.BOOKING_REQUESTED}, URL: ${sub.subscriberUrl}`,
          e
        );
      })
    );
    await Promise.all(promises);
  } catch (error) {
    // Silently fail
    console.error(error);
  }
}
