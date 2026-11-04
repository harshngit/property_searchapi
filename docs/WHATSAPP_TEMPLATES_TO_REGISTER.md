# WhatsApp templates to register with Meta

Three templates the code already sends, but which are not in the client's approved list of 29. Each needs:

1. The client approves the wording.
2. Someone submits it in Meta Business Manager → WhatsApp Manager → Message templates, category **Utility**, language **English (en_US)**.
3. Once Meta approves it, the step in the "After approval" column for that template.

Until a template is approved, the code falls back to a plain-text message. WhatsApp delivers plain text only inside the 24-hour window after the person's last message. After that, the reply silently doesn't reach them.

| Template name | Sent when | Variables | After approval |
|---|---|---|---|
| `ar_listing_not_listed` | Staff reject a property posted on WhatsApp | {{1}} reference, {{2}} reason | Add `"listing_rejected": "ar_listing_not_listed"` to the config `notifications.whatsapp_templates` |
| `ar_listing_in_review` | Staff accept a WhatsApp post but the listing still has a final duplicate / fraud check | {{1}} reference | Add `"listing_in_review": "ar_listing_in_review"` to `notifications.whatsapp_templates` |
| `lead_acknowledgement` (re-submit with the notice) | First reply to a lead whose details came from a portal email (feature #3) | {{1}} name | Nothing (the name is set by `WHATSAPP_TEMPLATE_ACK`, default `lead_acknowledgement`) |

Change the config in the CRM under Admin Panel → Settings → `notifications.whatsapp_templates`, or with `PUT /api/admin/config/notifications.whatsapp_templates`. Keep every existing key when you add the new one.

## Draft wording

### ar_listing_not_listed

> Hello, your property {{1}} could not be listed on PropertySerch.
>
> Reason: {{2}}
>
> Reply to this message with the missing details or photos and our team will review it again.
>
> A R Buildwel | PropertySerch

Example for Meta: {{1}} = `CL-2026-000123`, {{2}} = `The price was not shared`.

### ar_listing_in_review

> Hello, your property {{1}} has been accepted and is in a final check by the A R Buildwel team. We will message you as soon as it is live on PropertySerch.
>
> A R Buildwel | PropertySerch

Example for Meta: {{1}} = `CL-2026-000123`.

### lead_acknowledgement, with the DPDP notice

> Hi {{1}}, thanks for your enquiry. Your details reached PropertySerch through a property portal, and our team will get in touch shortly.
>
> We use your details only to respond to this enquiry, as our privacy policy explains: propertyserch.com/privacy
>
> Reply STOP, or write to privacy@propertyserch.com, to have them deleted.

Example for Meta: {{1}} = `Rahul`.

This is the same notice the backend logs on the lead (`ingestion.email_privacy_notice`). If the client changes one, change the other to match.

## Why the Telegram side needs nothing

Telegram has no 24-hour window and no templates. Telegram posters get the same replies as plain text, and when a listing goes live the reply also carries its Telegram smart link (`https://t.me/<bot>?start=p_<listing id>`). That needs `TELEGRAM_BOT_USERNAME` to be set on the API server.
