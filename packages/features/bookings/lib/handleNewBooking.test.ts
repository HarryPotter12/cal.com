/**
 * How to ensure that unmocked prisma queries aren't called?
 */
import type { Request, Response } from "express";
import type { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import type Stripe from "stripe";
import { describe, expect, beforeEach } from "vitest";

import { WEBAPP_URL } from "@calcom/lib/constants";
import { BookingStatus } from "@calcom/prisma/enums";
import { test } from "@calcom/web/test/fixtures/fixtures";
import {
  createBookingScenario,
  getDate,
  getGoogleCalendarCredential,
  TestData,
  getOrganizer,
  getBooker,
  getScenarioData,
  getZoomAppCredential,
  mockEnableEmailFeature,
  mockNoTranslations,
  mockErrorOnVideoMeetingCreation,
  mockSuccessfulVideoMeetingCreation,
  mockCalendarToHaveNoBusySlots,
  getStripeAppCredential,
  MockError,
  mockPaymentApp,
} from "@calcom/web/test/utils/bookingScenario/bookingScenario";

import {
  expectWorkflowToBeTriggered,
  expectBookingToBeInDatabase,
  expectWebhookToHaveBeenCalledWith,
} from "@calcom/web/test/utils/bookingScenario/expects";

import { handlePaymentSuccess } from "@calcom/features/ee/payments/api/webhook";

type CustomNextApiRequest = NextApiRequest & Request;

type CustomNextApiResponse = NextApiResponse & Response;
// Local test runs sometime gets too slow
const timeout = process.env.CI ? 5000 : 20000;
describe.sequential("handleNewBooking", () => {
  beforeEach(() => {
    // Required to able to generate token in email in some cases
    process.env.CALENDSO_ENCRYPTION_KEY = "abcdefghjnmkljhjklmnhjklkmnbhjui";
    process.env.STRIPE_WEBHOOK_SECRET = "MOCK_STRIPE_WEBHOOK_SECRET";
    mockNoTranslations();
    mockEnableEmailFeature();
    globalThis.testEmails = [];
    fetchMock.resetMocks();
  });

  describe.sequential("Frontend:", () => {
    test(
      `should create a successful booking with Cal Video(Daily Video) if no explicit location is provided
      1. Should create a booking in the database
      2. Should send emails to the booker as well as organizer
      3. Should trigger BOOKING_CREATED webhook
    `,
      async ({ emails }) => {
        const handleNewBooking = (await import("@calcom/features/bookings/lib/handleNewBooking")).default;
        const booker = getBooker({
          email: "booker@example.com",
          name: "Booker",
        });

        const organizer = getOrganizer({
          name: "Organizer",
          email: "organizer@example.com",
          id: 101,
          schedules: [TestData.schedules.IstWorkHours],
          credentials: [getGoogleCalendarCredential()],
          selectedCalendars: [TestData.selectedCalendars.google],
        });

        const mockBookingData = getMockRequestDataForBooking({
          data: {
            eventTypeId: 1,
            responses: {
              email: booker.email,
              name: booker.name,
              location: { optionValue: "", value: "integrations:daily" },
            },
          },
        });

        const { req } = createMockNextJsRequest({
          method: "POST",
          body: mockBookingData,
        });

        const scenarioData = getScenarioData({
          webhooks: [
            {
              userId: organizer.id,
              eventTriggers: ["BOOKING_CREATED"],
              subscriberUrl: "http://my-webhook.example.com",
              active: true,
              eventTypeId: 1,
              appId: null,
            },
          ],
          eventTypes: [
            {
              id: 1,
              slotInterval: 45,
              length: 45,
              users: [
                {
                  id: 101,
                },
              ],
            },
          ],
          organizer,
          apps: [TestData.apps["google-calendar"], TestData.apps["daily-video"]],
        });

        mockSuccessfulVideoMeetingCreation({
          metadataLookupKey: "dailyvideo",
        });

        mockCalendarToHaveNoBusySlots("googlecalendar");
        createBookingScenario(scenarioData);

        const createdBooking = await handleNewBooking(req);
        expect(createdBooking.responses).toContain({
          email: booker.email,
          name: booker.name,
        });

        expect(createdBooking).toContain({
          location: "integrations:daily",
        });

        expectBookingToBeInDatabase({
          description: "",
          id: createdBooking.id,
          eventTypeId:mockBookingData.eventTypeId,
          status: BookingStatus.ACCEPTED,
        });

        expectWorkflowToBeTriggered();

        const testEmails = emails.get();
        expect(testEmails).toHaveEmail({
          htmlToContain: "<title>confirmed_event_type_subject</title>",
          to: `${organizer.email}`,
        }, `${organizer.email}`);
        expect(testEmails).toHaveEmail({
          htmlToContain: "<title>confirmed_event_type_subject</title>",
          to: `${booker.name} <${booker.email}>`,
        }, `${booker.name} <${booker.email}>`);
        expectWebhookToHaveBeenCalledWith("http://my-webhook.example.com", {
          triggerEvent: "BOOKING_CREATED",
          payload: {
            metadata: {
              videoCallUrl: `${WEBAPP_URL}/video/DYNAMIC_UID`,
            },
            responses: {
              name: { label: "your_name", value: "Booker" },
              email: { label: "email_address", value: "booker@example.com" },
              location: {
                label: "location",
                value: { optionValue: "", value: "integrations:daily" },
              },
            },
          },
        });
      },
      timeout
    );

    test(
      `should submit a booking request for event requiring confirmation
      1. Should create a booking in the database with status PENDING
      2. Should send emails to the booker as well as organizer for booking request and awaiting approval
      3. Should trigger BOOKING_REQUESTED webhook
    `,
      async ({ emails }) => {
        const handleNewBooking = (await import("@calcom/features/bookings/lib/handleNewBooking")).default;
        const booker = getBooker({
          email: "booker@example.com",
          name: "Booker",
        });

        const organizer = getOrganizer({
          name: "Organizer",
          email: "organizer@example.com",
          id: 101,
          schedules: [TestData.schedules.IstWorkHours],
          credentials: [getGoogleCalendarCredential()],
          selectedCalendars: [TestData.selectedCalendars.google],
        });

        const mockBookingData = getMockRequestDataForBooking({
          data: {
            eventTypeId: 1,
            responses: {
              email: booker.email,
              name: booker.name,
              location: { optionValue: "", value: "integrations:daily" },
            },
          },
        });

        const { req } = createMockNextJsRequest({
          method: "POST",
          body: mockBookingData,
        });

        const scenarioData = getScenarioData({
          webhooks: [
            {
              userId: organizer.id,
              eventTriggers: ["BOOKING_CREATED"],
              subscriberUrl: "http://my-webhook.example.com",
              active: true,
              eventTypeId: 1,
              appId: null,
            },
          ],
          eventTypes: [
            {
              id: 1,
              slotInterval: 45,
              requiresConfirmation: true,
              length: 45,
              users: [
                {
                  id: 101,
                },
              ],
            },
          ],
          organizer,
          apps: [TestData.apps["google-calendar"], TestData.apps["daily-video"]],
        });

        mockSuccessfulVideoMeetingCreation({
          metadataLookupKey: "dailyvideo",
        });

        mockCalendarToHaveNoBusySlots("googlecalendar");
        createBookingScenario(scenarioData);

        const createdBooking = await handleNewBooking(req);
        expect(createdBooking.responses).toContain({
          email: booker.email,
          name: booker.name,
        });

        expect(createdBooking).toContain({
          location: "integrations:daily",
        });

        expectBookingToBeInDatabase({
          description: "",
          id: createdBooking.id,
          eventTypeId: mockBookingData.eventTypeId,
          status: BookingStatus.PENDING,
        });

        expectWorkflowToBeTriggered();

        const testEmails = emails.get();
        expect(testEmails).toHaveEmail({
          htmlToContain: "<title>event_awaiting_approval_subject</title>",
          to: `${organizer.email}`,
        }, `${organizer.email}`);

        expect(testEmails).toHaveEmail({
          htmlToContain: "<title>booking_submitted_subject</title>",
          to: `${booker.email}`,
        }, `${booker.email}`);

        expectWebhookToHaveBeenCalledWith("http://my-webhook.example.com", {
          triggerEvent: "BOOKING_REQUESTED",
          payload: {
            metadata: {
              // In a Pending Booking Request, we don't send the video call url
            },
            responses: {
              name: { label: "your_name", value: "Booker" },
              email: { label: "email_address", value: "booker@example.com" },
              location: {
                label: "location",
                value: { optionValue: "", value: "integrations:daily" },
              },
            },
          },
        });
      },
      timeout
    );

    test(
      `if booking with Cal Video(Daily Video) fails, booking creation fails with uncaught error`,
      async ({}) => {
        const handleNewBooking = (await import("@calcom/features/bookings/lib/handleNewBooking")).default;
        const booker = getBooker({
          email: "booker@example.org",
          name: "Booker",
        });
        const organizer = TestData.users.example;
        const { req } = createMockNextJsRequest({
          method: "POST",
          body: getMockRequestDataForBooking({
            data: {
              eventTypeId: 1,
              responses: {
                email: booker.email,
                name: booker.name,
                location: { optionValue: "", value: "integrations:daily" },
              },
            },
          }),
        });

        const scenarioData = {
          hosts: [],
          eventTypes: [
            {
              id: 1,
              slotInterval: 45,
              length: 45,
              users: [
                {
                  id: 101,
                },
              ],
            },
          ],
          users: [
            {
              ...organizer,
              id: 101,
              schedules: [TestData.schedules.IstWorkHours],
              credentials: [getGoogleCalendarCredential()],
              selectedCalendars: [TestData.selectedCalendars.google],
            },
          ],
          apps: [TestData.apps["google-calendar"], TestData.apps["daily-video"]],
        };

        mockErrorOnVideoMeetingCreation({
          metadataLookupKey: "dailyvideo",
        });
        mockCalendarToHaveNoBusySlots("googlecalendar");

        createBookingScenario(scenarioData);

        try {
          await handleNewBooking(req);
        } catch (e) {
          expect(e).toBeInstanceOf(MockError);
          expect((e as { message: string }).message).toBe("Error creating Video meeting");
        }
      },
      timeout
    );

    test(
      `should create a successful booking with Zoom if used`,
      async ({ emails }) => {
        const handleNewBooking = (await import("@calcom/features/bookings/lib/handleNewBooking")).default;
        const booker = getBooker({
          email: "booker@example.com",
          name: "Booker",
        });

        const organizer = getOrganizer({
          name: "Organizer",
          email: "organizer@example.com",
          id: 101,
          schedules: [TestData.schedules.IstWorkHours],
          credentials: [getZoomAppCredential()],
          selectedCalendars: [TestData.selectedCalendars.google],
        });

        const { req } = createMockNextJsRequest({
          method: "POST",
          body: getMockRequestDataForBooking({
            data: {
              eventTypeId: 1,
              responses: {
                email: booker.email,
                name: booker.name,
                location: { optionValue: "", value: "integrations:zoom" },
              },
            },
          }),
        });

        const bookingScenario = getScenarioData({
          organizer,
          eventTypes: [
            {
              id: 1,
              slotInterval: 45,
              length: 45,
              users: [
                {
                  id: 101,
                },
              ],
            },
          ],
          apps: [TestData.apps["daily-video"]],
          webhooks: [
            {
              userId: organizer.id,
              eventTriggers: ["BOOKING_CREATED"],
              subscriberUrl: "http://my-webhook.example.com",
              active: true,
              eventTypeId: 1,
              appId: null,
            },
          ],
        });

        createBookingScenario(bookingScenario);
        mockSuccessfulVideoMeetingCreation({
          metadataLookupKey: "zoomvideo",
        });
        await handleNewBooking(req);

        const testEmails = emails.get();
        expect(testEmails).toHaveEmail({
          htmlToContain: "<title>confirmed_event_type_subject</title>",
          to: `${organizer.email}`,
        }, `${organizer.email}`);

        expect(testEmails).toHaveEmail({
          htmlToContain: "<title>confirmed_event_type_subject</title>",
          to: `${booker.name} <${booker.email}>`,
        }, `${booker.name} <${booker.email}>`);

        expectWebhookToHaveBeenCalledWith("http://my-webhook.example.com", {
          triggerEvent: "BOOKING_CREATED",
          payload: {
            metadata: {
              videoCallUrl: "http://mock-zoomvideo.example.com",
            },
            responses: {
              name: { label: "your_name", value: "Booker" },
              email: { label: "email_address", value: "booker@example.com" },
              location: {
                label: "location",
                value: { optionValue: "", value: "integrations:zoom" },
              },
            },
          },
        });
      },
      timeout
    );
    describe("Paid Events", ()=>{
      test(
        `Event Type that doesn't require confirmation
        1. Should create a booking in the database with status PENDING
        2. Should send email to the booker for Payment request
        3. Should trigger BOOKING_PAYMENT_INITIATED webhook
        4. Once payment is successful, should trigger BOOKING_CREATED webhook
      `,
        async ({ emails }) => {
          const handleNewBooking = (await import("@calcom/features/bookings/lib/handleNewBooking")).default;
          const booker = getBooker({
            email: "booker@example.com",
            name: "Booker",
          });
  
          const organizer = getOrganizer({
            name: "Organizer",
            email: "organizer@example.com",
            id: 101,
            schedules: [TestData.schedules.IstWorkHours],
            credentials: [getGoogleCalendarCredential(), getStripeAppCredential()],
            selectedCalendars: [TestData.selectedCalendars.google],
          });
  
          const mockBookingData = getMockRequestDataForBooking({
            data: {
              eventTypeId: 1,
              responses: {
                email: booker.email,
                name: booker.name,
                location: { optionValue: "", value: "integrations:daily" },
              },
            },
          });
  
          const { req } = createMockNextJsRequest({
            method: "POST",
            body: mockBookingData,
          });
  
          const scenarioData = getScenarioData({
            webhooks: [
              {
                userId: organizer.id,
                eventTriggers: ["BOOKING_CREATED"],
                subscriberUrl: "http://my-webhook.example.com",
                active: true,
                eventTypeId: 1,
                appId: null,
              },
            ],
            eventTypes: [
              {
                id: 1,
                slotInterval: 45,
                requiresConfirmation: false,
                metadata: {
                  apps: {
                    stripe: {
                      price: 100,
                      enabled: true,
                      currency: "inr" /*, credentialId: 57*/,
                    },
                  },
                },
                length: 45,
                users: [
                  {
                    id: 101,
                  },
                ],
              },
            ],
            organizer,
            apps: [
              TestData.apps["google-calendar"],
              TestData.apps["daily-video"],
              TestData.apps["stripe-payment"],
            ],
          });
  
          mockSuccessfulVideoMeetingCreation({
            metadataLookupKey: "dailyvideo",
          });
  
          const { paymentUid, externalId } = mockPaymentApp({
            metadataLookupKey: "stripe",
            appStoreLookupKey: "stripepayment",
          });
  
          mockCalendarToHaveNoBusySlots("googlecalendar");
          createBookingScenario(scenarioData);
  
          const createdBooking = await handleNewBooking(req);
          expect(createdBooking.responses).toContain({
            email: booker.email,
            name: booker.name,
          });
  
          expect(createdBooking).toContain({
            location: "integrations:daily",
            paymentUid: paymentUid,
          });
  
          expectBookingToBeInDatabase({
            description: "",
            id:createdBooking.id,
            eventTypeId: mockBookingData.eventTypeId,
            status: BookingStatus.PENDING,
          });
  
          expectWorkflowToBeTriggered();
  
          const testEmails = emails.get();
  
          expect(testEmails).toHaveEmail({
            htmlToContain: "<title>awaiting_payment_subject</title>",
            to: `${booker.name} <${booker.email}>`,
          }, `${booker.name} <${booker.email}>`);
  
          expectWebhookToHaveBeenCalledWith("http://my-webhook.example.com", {
            triggerEvent: "BOOKING_PAYMENT_INITIATED",
            payload: {
              metadata: {
                // In a Pending Booking Request, we don't send the video call url
              },
              responses: {
                name: { label: "your_name", value: "Booker" },
                email: { label: "email_address", value: "booker@example.com" },
                location: {
                  label: "location",
                  value: { optionValue: "", value: "integrations:daily" },
                },
              },
            },
          });
  
          try {
            await handlePaymentSuccess(
              (function getMockedStripePaymentEvent({ paymentIntentId }) {
                return {
                  id: 1,
                  data: {
                    object: {
                      id: paymentIntentId,
                    },
                  },
                } as unknown as Stripe.Event;
              })({ paymentIntentId: externalId })
            );
          } catch (e) {
            expect(e.statusCode).toBe(200);
          }

          expectBookingToBeInDatabase({
            description: "",
            id: createdBooking.id,
            eventTypeId: mockBookingData.eventTypeId,
            status: BookingStatus.ACCEPTED,
          });

          expectWebhookToHaveBeenCalledWith("http://my-webhook.example.com", {
            triggerEvent: "BOOKING_CREATED",
            payload: {
              // FIXME: File this bug and link ticket here. This is a bug in the code. metadata must be sent here like other BOOKING_CREATED webhook
              metadata: null,
              responses: {
                name: { label: "name", value: "Booker" },
                email: { label: "email", value: "booker@example.com" },
                location: {
                  label: "location",
                  value: { optionValue: "", value: "integrations:daily" },
                },
              },
            },
          });
        },
        timeout
      );
      // TODO: We should introduce a new state BOOKING.PAYMENT_PENDING that can clearly differentiate b/w pending confirmation(stuck on Organizer) and pending payment(stuck on booker)
      test(
        `Event Type that requires confirmation
        1. Should create a booking in the database with status PENDING
        2. Should send email to the booker for Payment request
        3. Should trigger BOOKING_PAYMENT_INITIATED webhook
        4. Once payment is successful, should trigger BOOKING_REQUESTED webhook
        5. Booking should still stay in pending state
      `,
        async ({ emails }) => {
          const handleNewBooking = (await import("@calcom/features/bookings/lib/handleNewBooking")).default;
          const booker = getBooker({
            email: "booker@example.com",
            name: "Booker",
          });
  
          const organizer = getOrganizer({
            name: "Organizer",
            email: "organizer@example.com",
            id: 101,
            schedules: [TestData.schedules.IstWorkHours],
            credentials: [getGoogleCalendarCredential(), getStripeAppCredential()],
            selectedCalendars: [TestData.selectedCalendars.google],
          });

          const scenarioData = getScenarioData({
            webhooks: [
              {
                userId: organizer.id,
                eventTriggers: ["BOOKING_CREATED"],
                subscriberUrl: "http://my-webhook.example.com",
                active: true,
                eventTypeId: 1,
                appId: null,
              },
            ],
            eventTypes: [
              {
                id: 1,
                slotInterval: 45,
                requiresConfirmation: true,
                metadata: {
                  apps: {
                    stripe: {
                      price: 100,
                      enabled: true,
                      currency: "inr" /*, credentialId: 57*/,
                    },
                  },
                },
                length: 45,
                users: [
                  {
                    id: 101,
                  },
                ],
              },
            ],
            organizer,
            apps: [
              TestData.apps["google-calendar"],
              TestData.apps["daily-video"],
              TestData.apps["stripe-payment"],
            ],
          });
          createBookingScenario(scenarioData);

          const mockBookingData = getMockRequestDataForBooking({
            data: {
              eventTypeId: 1,
              responses: {
                email: booker.email,
                name: booker.name,
                location: { optionValue: "", value: "integrations:daily" },
              },
            },
          });

          mockSuccessfulVideoMeetingCreation({
            metadataLookupKey: "dailyvideo",
          });
  
          const { paymentUid, externalId } = mockPaymentApp({
            metadataLookupKey: "stripe",
            appStoreLookupKey: "stripepayment",
          });
  
          mockCalendarToHaveNoBusySlots("googlecalendar");
  
          const { req } = createMockNextJsRequest({
            method: "POST",
            body: mockBookingData,
          });
  
          const createdBooking = await handleNewBooking(req);
          expect(createdBooking.responses).toContain({
            email: booker.email,
            name: booker.name,
          });
  
          expect(createdBooking).toContain({
            location: "integrations:daily",
            paymentUid: paymentUid,
          });
  
          expectBookingToBeInDatabase({
            description: "",
            id: createdBooking.id,
            eventTypeId: mockBookingData.eventTypeId,
            status: BookingStatus.PENDING,
          });
  
          expectWorkflowToBeTriggered();
  
          const testEmails = emails.get();
  
          expect(testEmails).toHaveEmail({
            htmlToContain: "<title>awaiting_payment_subject</title>",
            to: `${booker.name} <${booker.email}>`,
          }, `${booker.name} <${booker.email}>`);
  
          expectWebhookToHaveBeenCalledWith("http://my-webhook.example.com", {
            triggerEvent: "BOOKING_PAYMENT_INITIATED",
            payload: {
              metadata: {
                // In a Pending Booking Request, we don't send the video call url
              },
              responses: {
                name: { label: "your_name", value: "Booker" },
                email: { label: "email_address", value: "booker@example.com" },
                location: {
                  label: "location",
                  value: { optionValue: "", value: "integrations:daily" },
                },
              },
            },
          });


          try {
            await handlePaymentSuccess(
              (function getMockedStripePaymentEvent({ paymentIntentId }) {
                return {
                  id: 1,
                  data: {
                    object: {
                      id: paymentIntentId,
                    },
                  },
                } as unknown as Stripe.Event;
              })({ paymentIntentId: externalId })
            );
          } catch (e) {
            expect(e.statusCode).toBe(200);
          }

          expectBookingToBeInDatabase({
            description: "",
            id: createdBooking.id,
            eventTypeId: mockBookingData.eventTypeId,
            status: BookingStatus.PENDING,
          });

          expectWebhookToHaveBeenCalledWith("http://my-webhook.example.com", {
            triggerEvent: "BOOKING_REQUESTED",
            payload: {
              // FIXME: File this bug and link ticket here. This is a bug in the code. metadata must be sent here like other BOOKING_CREATED webhook
              metadata: null,
              responses: {
                name: { label: "name", value: "Booker" },
                email: { label: "email", value: "booker@example.com" },
                location: {
                  label: "location",
                  value: { optionValue: "", value: "integrations:daily" },
                },
              },
            },
          });
        },
        timeout
      );
    })
  });
});

function createMockNextJsRequest(...args: Parameters<typeof createMocks>) {
  return createMocks<CustomNextApiRequest, CustomNextApiResponse>(...args);
}

function getBasicMockRequestDataForBooking() {
  return {
    start: `${getDate({ dateIncrement: 1 }).dateString}T04:00:00.000Z`,
    end: `${getDate({ dateIncrement: 1 }).dateString}T04:30:00.000Z`,
    eventTypeSlug: "no-confirmation",
    timeZone: "Asia/Calcutta",
    language: "en",
    bookingUid: "bvCmP5rSquAazGSA7hz7ZP",
    user: "teampro",
    metadata: {},
    hasHashedBookingLink: false,
    hashedLink: null,
  };
}

function getMockRequestDataForBooking({
  data,
}: {
  data: Partial<ReturnType<typeof getBasicMockRequestDataForBooking>> & {
    eventTypeId: number;
    responses: {
      email: string;
      name: string;
      location: { optionValue: ""; value: string };
    };
  };
}) {
  return {
    ...getBasicMockRequestDataForBooking(),
    ...data,
  };
}
