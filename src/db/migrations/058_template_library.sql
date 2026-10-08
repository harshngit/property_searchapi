-- Module 50 - the launch template library (sec. 36.1): 14 blank master templates with their variables.
-- Generated from templates created through the engine, so every one has passed the contact and
-- forbidden-terms validators. Each is a working draft for the client's own advocate; edit them from
-- CRM > Document Templates (an edit makes a new version - this file is only the starting point).

INSERT INTO document_templates (template_key, name, category, description, audience, duty_transaction, status, current_version, sort_order) VALUES ('agreement_to_sell', $tpl$Agreement to Sell (ATS) / Sale Agreement$tpl$, 'sale', $tpl$Agreement to sell a property, with token amount, balance and possession date.$tpl$, 'professional', 'sale', 'active', 1, 1) ON CONFLICT (template_key) DO NOTHING;
INSERT INTO document_template_versions (template_id, version, body, state_blocks, change_note) VALUES ((SELECT id FROM document_templates WHERE template_key = 'agreement_to_sell'), 1, $tpl$# Agreement to Sell

This Agreement to Sell is made at {{execution_place}} on this {{execution_date}}

## Between

{{seller_name}}, {{seller_parent_name}}, residing at {{seller_address}} (hereinafter called the "Seller", which expression shall include legal heirs, successors and assigns) of the First Part;

## And

{{buyer_name}}, {{buyer_parent_name}}, residing at {{buyer_address}} (hereinafter called the "Buyer", which expression shall include legal heirs, successors and assigns) of the Second Part.

## Scheduled Property

All that property situated at {{property_address}}, being {{property_description}} (the "Scheduled Property").

{{state_clauses}}

## 1. Sale consideration

The Seller agrees to sell and the Buyer agrees to purchase the Scheduled Property for a total sale consideration of {{sale_consideration}} ({{sale_consideration_words}}).

## 2. Token amount

The Buyer has paid to the Seller a sum of {{token_amount}} ({{token_amount_words}}) as token amount, by {{payment_mode}}, the receipt of which the Seller acknowledges. The balance shall be paid on or before the execution of the Sale Deed.

## 3. Possession and completion

The Sale Deed shall be executed and vacant physical possession handed over on or before {{possession_date}}.

## 4. Title

The Seller declares that the Seller is the absolute owner of the Scheduled Property, that it is free from encumbrances, charges, liens and litigation, and that the Seller has full right to sell it. The Seller shall deliver all original title documents at the time of the Sale Deed.

## 5. Stamp duty and registration

Stamp duty of {{stamp_duty_amount}} and the registration fee of {{registration_fee_amount}}, indicative as per the rules of the State, and incidental expenses of the Sale Deed shall be borne by the {{duty_borne_by}}.

## 6. Default

If the Buyer fails to complete the purchase within the agreed time for reasons attributable to the Buyer, the Seller may forfeit the token amount. If the Seller fails to complete the sale, the Seller shall refund double the token amount, without prejudice to the Buyer's right to seek specific performance.

## 7. Outgoings

All taxes, charges and outgoings on the Scheduled Property up to the date of possession shall be borne by the Seller and thereafter by the Buyer.

## Witnesses

IN WITNESS WHEREOF the parties have signed this document on the date first written above in the presence of the following witnesses.

Witness 1: {{witness_1_name}}

Witness 2: {{witness_2_name}}$tpl$, $tpl$[{"body": "## Karnataka particulars\n\nThe Scheduled Property bears Khata No. {{khata_number}} and Survey No. {{survey_number}} in the records of the jurisdictional authority.", "stateCode": "KA"}, {"body": "## Tamil Nadu particulars\n\nThe Scheduled Property is comprised in Patta No. {{patta_number}} and Survey No. {{survey_number}} in the revenue records.", "stateCode": "TN"}, {"body": "## Delhi particulars\n\nWhere the Scheduled Property lies within Lal Dora / extended Lal Dora, the certificate bearing No. {{lal_dora_certificate}} issued by the competent authority forms part of the title papers.", "stateCode": "DL"}]$tpl$::jsonb, 'Launch library') ON CONFLICT (template_id, version) DO NOTHING;
INSERT INTO template_variables (template_id, name, label, field_type, options, validation, is_required, help_text, prefill, computed, state_codes, sort_order) VALUES
  ((SELECT id FROM document_templates WHERE template_key = 'agreement_to_sell'), 'execution_place', $tpl$Place of execution$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$property.city$tpl$, NULL, $tpl$[]$tpl$::jsonb, 1),
  ((SELECT id FROM document_templates WHERE template_key = 'agreement_to_sell'), 'execution_date', $tpl$Date of execution$tpl$, 'date', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 2),
  ((SELECT id FROM document_templates WHERE template_key = 'agreement_to_sell'), 'seller_name', $tpl$Seller name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$deal.seller_name$tpl$, NULL, $tpl$[]$tpl$::jsonb, 3),
  ((SELECT id FROM document_templates WHERE template_key = 'agreement_to_sell'), 'seller_parent_name', $tpl$Seller: son / daughter / wife of$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 4),
  ((SELECT id FROM document_templates WHERE template_key = 'agreement_to_sell'), 'seller_address', $tpl$Seller address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 5),
  ((SELECT id FROM document_templates WHERE template_key = 'agreement_to_sell'), 'buyer_name', $tpl$Buyer name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$deal.buyer_name$tpl$, NULL, $tpl$[]$tpl$::jsonb, 6),
  ((SELECT id FROM document_templates WHERE template_key = 'agreement_to_sell'), 'buyer_parent_name', $tpl$Buyer: son / daughter / wife of$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 7),
  ((SELECT id FROM document_templates WHERE template_key = 'agreement_to_sell'), 'buyer_address', $tpl$Buyer address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 8),
  ((SELECT id FROM document_templates WHERE template_key = 'agreement_to_sell'), 'property_address', $tpl$Property address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, $tpl$Full address as in the title documents$tpl$, $tpl$property.address$tpl$, NULL, $tpl$[]$tpl$::jsonb, 9),
  ((SELECT id FROM document_templates WHERE template_key = 'agreement_to_sell'), 'property_description', $tpl$Property description$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, $tpl$Type, floor, area, boundaries$tpl$, $tpl$property.description$tpl$, NULL, $tpl$[]$tpl$::jsonb, 10),
  ((SELECT id FROM document_templates WHERE template_key = 'agreement_to_sell'), 'sale_consideration', $tpl$Total sale consideration$tpl$, 'currency', $tpl$[]$tpl$::jsonb, $tpl${"min": 1}$tpl$::jsonb, true, NULL, $tpl$deal.value$tpl$, NULL, $tpl$[]$tpl$::jsonb, 11),
  ((SELECT id FROM document_templates WHERE template_key = 'agreement_to_sell'), 'sale_consideration_words', $tpl$sale consideration in words$tpl$, 'computed', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, $tpl${"of": "sale_consideration", "kind": "amount_in_words"}$tpl$::jsonb, $tpl$[]$tpl$::jsonb, 12),
  ((SELECT id FROM document_templates WHERE template_key = 'agreement_to_sell'), 'token_amount', $tpl$Token amount$tpl$, 'currency', $tpl$[]$tpl$::jsonb, $tpl${"min": 1}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 13),
  ((SELECT id FROM document_templates WHERE template_key = 'agreement_to_sell'), 'token_amount_words', $tpl$token amount in words$tpl$, 'computed', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, $tpl${"of": "token_amount", "kind": "amount_in_words"}$tpl$::jsonb, $tpl$[]$tpl$::jsonb, 14),
  ((SELECT id FROM document_templates WHERE template_key = 'agreement_to_sell'), 'payment_mode', $tpl$Token paid by$tpl$, 'dropdown', $tpl$["bank transfer", "cheque", "demand draft"]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 15),
  ((SELECT id FROM document_templates WHERE template_key = 'agreement_to_sell'), 'possession_date', $tpl$Possession / Sale Deed on or before$tpl$, 'date', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 16),
  ((SELECT id FROM document_templates WHERE template_key = 'agreement_to_sell'), 'stamp_duty_amount', $tpl$Stamp duty (from the state rules)$tpl$, 'computed', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, $tpl${"of": "sale_consideration", "kind": "stamp_duty"}$tpl$::jsonb, $tpl$[]$tpl$::jsonb, 17),
  ((SELECT id FROM document_templates WHERE template_key = 'agreement_to_sell'), 'registration_fee_amount', $tpl$Registration fee (from the state rules)$tpl$, 'computed', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, $tpl${"of": "sale_consideration", "kind": "registration_fee"}$tpl$::jsonb, $tpl$[]$tpl$::jsonb, 18),
  ((SELECT id FROM document_templates WHERE template_key = 'agreement_to_sell'), 'duty_borne_by', $tpl$Stamp duty and registration borne by$tpl$, 'dropdown', $tpl$["Buyer", "Seller", "Buyer and Seller equally"]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 19),
  ((SELECT id FROM document_templates WHERE template_key = 'agreement_to_sell'), 'khata_number', $tpl$Khata number$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, $tpl$From the BBMP / panchayat khata certificate$tpl$, NULL, NULL, $tpl$["KA"]$tpl$::jsonb, 20),
  ((SELECT id FROM document_templates WHERE template_key = 'agreement_to_sell'), 'patta_number', $tpl$Patta number$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$["TN"]$tpl$::jsonb, 21),
  ((SELECT id FROM document_templates WHERE template_key = 'agreement_to_sell'), 'survey_number', $tpl$Survey number$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$["KA", "TN", "AP", "TS", "MH", "GJ"]$tpl$::jsonb, 22),
  ((SELECT id FROM document_templates WHERE template_key = 'agreement_to_sell'), 'lal_dora_certificate', $tpl$Lal Dora certificate number$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$["DL"]$tpl$::jsonb, 23),
  ((SELECT id FROM document_templates WHERE template_key = 'agreement_to_sell'), 'witness_1_name', $tpl$Witness 1 name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 24),
  ((SELECT id FROM document_templates WHERE template_key = 'agreement_to_sell'), 'witness_2_name', $tpl$Witness 2 name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 25)
ON CONFLICT (template_id, name) DO NOTHING;

INSERT INTO document_templates (template_key, name, category, description, audience, duty_transaction, status, current_version, sort_order) VALUES ('sale_deed', $tpl$Sale Deed$tpl$, 'sale', $tpl$Deed of absolute sale conveying the property to the buyer.$tpl$, 'professional', 'sale', 'active', 1, 2) ON CONFLICT (template_key) DO NOTHING;
INSERT INTO document_template_versions (template_id, version, body, state_blocks, change_note) VALUES ((SELECT id FROM document_templates WHERE template_key = 'sale_deed'), 1, $tpl$# Sale Deed

This Deed of Absolute Sale is executed at {{execution_place}} on this {{execution_date}}

## By

{{seller_name}}, {{seller_parent_name}}, residing at {{seller_address}} (the "Vendor")

## In favour of

{{buyer_name}}, {{buyer_parent_name}}, residing at {{buyer_address}} (the "Purchaser").

## Recitals

The Vendor is the absolute owner in possession of the property situated at {{property_address}}, being {{property_description}} (the "Scheduled Property"), having acquired it by {{title_source}}.

{{state_clauses}}

## 1. Conveyance

In consideration of {{sale_consideration}} ({{sale_consideration_words}}) paid by the Purchaser to the Vendor, the receipt of which the Vendor admits and acknowledges, the Vendor hereby sells, conveys and transfers the Scheduled Property to the Purchaser absolutely and forever, together with all rights, easements and appurtenances.

## 2. Possession

The Vendor has this day delivered vacant physical possession of the Scheduled Property to the Purchaser.

## 3. Covenants of the Vendor

The Vendor covenants that the Scheduled Property is free from all encumbrances, mortgages, charges, liens, attachments and claims; that all taxes and outgoings up to this date have been paid; and that the Vendor shall indemnify the Purchaser against any defect in title.

## 4. Mutation

The Purchaser is entitled to have the Scheduled Property mutated in the Purchaser's name in all public records, and the Vendor shall extend every co-operation for it.

## 5. Stamp duty

This deed is executed on stamp duty of {{stamp_duty_amount}} and a registration fee of {{registration_fee_amount}}, indicative as per the rules of the State, borne by the Purchaser.

## Witnesses

IN WITNESS WHEREOF the parties have signed this document on the date first written above in the presence of the following witnesses.

Witness 1: {{witness_1_name}}

Witness 2: {{witness_2_name}}$tpl$, $tpl$[{"body": "## Karnataka particulars\n\nThe Scheduled Property bears Khata No. {{khata_number}} and Survey No. {{survey_number}} in the records of the jurisdictional authority.", "stateCode": "KA"}, {"body": "## Tamil Nadu particulars\n\nThe Scheduled Property is comprised in Patta No. {{patta_number}} and Survey No. {{survey_number}} in the revenue records.", "stateCode": "TN"}, {"body": "## Delhi particulars\n\nWhere the Scheduled Property lies within Lal Dora / extended Lal Dora, the certificate bearing No. {{lal_dora_certificate}} issued by the competent authority forms part of the title papers.", "stateCode": "DL"}]$tpl$::jsonb, 'Launch library') ON CONFLICT (template_id, version) DO NOTHING;
INSERT INTO template_variables (template_id, name, label, field_type, options, validation, is_required, help_text, prefill, computed, state_codes, sort_order) VALUES
  ((SELECT id FROM document_templates WHERE template_key = 'sale_deed'), 'execution_place', $tpl$Place of execution$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$property.city$tpl$, NULL, $tpl$[]$tpl$::jsonb, 1),
  ((SELECT id FROM document_templates WHERE template_key = 'sale_deed'), 'execution_date', $tpl$Date of execution$tpl$, 'date', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 2),
  ((SELECT id FROM document_templates WHERE template_key = 'sale_deed'), 'seller_name', $tpl$Seller name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$deal.seller_name$tpl$, NULL, $tpl$[]$tpl$::jsonb, 3),
  ((SELECT id FROM document_templates WHERE template_key = 'sale_deed'), 'seller_parent_name', $tpl$Seller: son / daughter / wife of$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 4),
  ((SELECT id FROM document_templates WHERE template_key = 'sale_deed'), 'seller_address', $tpl$Seller address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 5),
  ((SELECT id FROM document_templates WHERE template_key = 'sale_deed'), 'buyer_name', $tpl$Buyer name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$deal.buyer_name$tpl$, NULL, $tpl$[]$tpl$::jsonb, 6),
  ((SELECT id FROM document_templates WHERE template_key = 'sale_deed'), 'buyer_parent_name', $tpl$Buyer: son / daughter / wife of$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 7),
  ((SELECT id FROM document_templates WHERE template_key = 'sale_deed'), 'buyer_address', $tpl$Buyer address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 8),
  ((SELECT id FROM document_templates WHERE template_key = 'sale_deed'), 'property_address', $tpl$Property address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, $tpl$Full address as in the title documents$tpl$, $tpl$property.address$tpl$, NULL, $tpl$[]$tpl$::jsonb, 9),
  ((SELECT id FROM document_templates WHERE template_key = 'sale_deed'), 'property_description', $tpl$Property description$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, $tpl$Type, floor, area, boundaries$tpl$, $tpl$property.description$tpl$, NULL, $tpl$[]$tpl$::jsonb, 10),
  ((SELECT id FROM document_templates WHERE template_key = 'sale_deed'), 'title_source', $tpl$How the seller acquired the property$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, $tpl$e.g. Sale Deed dated ... registered as document no. ...$tpl$, NULL, NULL, $tpl$[]$tpl$::jsonb, 11),
  ((SELECT id FROM document_templates WHERE template_key = 'sale_deed'), 'sale_consideration', $tpl$Sale consideration$tpl$, 'currency', $tpl$[]$tpl$::jsonb, $tpl${"min": 1}$tpl$::jsonb, true, NULL, $tpl$deal.value$tpl$, NULL, $tpl$[]$tpl$::jsonb, 12),
  ((SELECT id FROM document_templates WHERE template_key = 'sale_deed'), 'sale_consideration_words', $tpl$sale consideration in words$tpl$, 'computed', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, $tpl${"of": "sale_consideration", "kind": "amount_in_words"}$tpl$::jsonb, $tpl$[]$tpl$::jsonb, 13),
  ((SELECT id FROM document_templates WHERE template_key = 'sale_deed'), 'stamp_duty_amount', $tpl$Stamp duty (from the state rules)$tpl$, 'computed', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, $tpl${"of": "sale_consideration", "kind": "stamp_duty"}$tpl$::jsonb, $tpl$[]$tpl$::jsonb, 14),
  ((SELECT id FROM document_templates WHERE template_key = 'sale_deed'), 'registration_fee_amount', $tpl$Registration fee (from the state rules)$tpl$, 'computed', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, $tpl${"of": "sale_consideration", "kind": "registration_fee"}$tpl$::jsonb, $tpl$[]$tpl$::jsonb, 15),
  ((SELECT id FROM document_templates WHERE template_key = 'sale_deed'), 'khata_number', $tpl$Khata number$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, $tpl$From the BBMP / panchayat khata certificate$tpl$, NULL, NULL, $tpl$["KA"]$tpl$::jsonb, 16),
  ((SELECT id FROM document_templates WHERE template_key = 'sale_deed'), 'patta_number', $tpl$Patta number$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$["TN"]$tpl$::jsonb, 17),
  ((SELECT id FROM document_templates WHERE template_key = 'sale_deed'), 'survey_number', $tpl$Survey number$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$["KA", "TN", "AP", "TS", "MH", "GJ"]$tpl$::jsonb, 18),
  ((SELECT id FROM document_templates WHERE template_key = 'sale_deed'), 'lal_dora_certificate', $tpl$Lal Dora certificate number$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$["DL"]$tpl$::jsonb, 19),
  ((SELECT id FROM document_templates WHERE template_key = 'sale_deed'), 'witness_1_name', $tpl$Witness 1 name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 20),
  ((SELECT id FROM document_templates WHERE template_key = 'sale_deed'), 'witness_2_name', $tpl$Witness 2 name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 21)
ON CONFLICT (template_id, name) DO NOTHING;

INSERT INTO document_templates (template_key, name, category, description, audience, duty_transaction, status, current_version, sort_order) VALUES ('rent_agreement', $tpl$Rent Agreement / Lease Deed$tpl$, 'lease', $tpl$Lease of a residential or commercial property for a fixed term.$tpl$, 'all', 'lease', 'active', 1, 3) ON CONFLICT (template_key) DO NOTHING;
INSERT INTO document_template_versions (template_id, version, body, state_blocks, change_note) VALUES ((SELECT id FROM document_templates WHERE template_key = 'rent_agreement'), 1, $tpl$# Lease Deed

This Lease Deed is made at {{execution_place}} on this {{execution_date}}

## Between

{{lessor_name}}, residing at {{lessor_address}} (the "Lessor")

## And

{{lessee_name}}, residing at {{lessee_address}} (the "Lessee").

## Premises

The premises situated at {{property_address}}, being {{property_description}} (the "Premises").

## 1. Term

The lease is for a term of {{lease_term}} commencing on {{lease_start_date}}.

## 2. Rent

The Lessee shall pay a monthly rent of {{monthly_rent}} ({{monthly_rent_words}}), in advance, on or before the {{rent_due_day}} day of each month.

## 3. Security deposit

The Lessee has paid an interest-free refundable security deposit of {{security_deposit}} ({{security_deposit_words}}), to be refunded on vacating the Premises after adjusting dues, if any.

## 4. Escalation

The rent shall increase by {{escalation_percent}} percent after every {{escalation_months}} months.

## 5. Use and maintenance

The Premises shall be used only for {{permitted_use}} purposes. The Lessee shall keep the Premises in good condition and shall not make structural changes without the Lessor's written consent. Electricity, water and maintenance charges shall be borne by the Lessee.

## 6. Termination

Either party may terminate this lease by giving {{notice_period}} written notice. The lock-in period is {{lock_in_period}}.

## 7. Sub-letting

The Lessee shall not sub-let or part with possession of the Premises or any part of it.

## Witnesses

IN WITNESS WHEREOF the parties have signed this document on the date first written above in the presence of the following witnesses.

Witness 1: {{witness_1_name}}

Witness 2: {{witness_2_name}}$tpl$, $tpl$[]$tpl$::jsonb, 'Launch library') ON CONFLICT (template_id, version) DO NOTHING;
INSERT INTO template_variables (template_id, name, label, field_type, options, validation, is_required, help_text, prefill, computed, state_codes, sort_order) VALUES
  ((SELECT id FROM document_templates WHERE template_key = 'rent_agreement'), 'execution_place', $tpl$Place of execution$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$property.city$tpl$, NULL, $tpl$[]$tpl$::jsonb, 1),
  ((SELECT id FROM document_templates WHERE template_key = 'rent_agreement'), 'execution_date', $tpl$Date of execution$tpl$, 'date', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 2),
  ((SELECT id FROM document_templates WHERE template_key = 'rent_agreement'), 'lessor_name', $tpl$Lessor (owner) name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$deal.seller_name$tpl$, NULL, $tpl$[]$tpl$::jsonb, 3),
  ((SELECT id FROM document_templates WHERE template_key = 'rent_agreement'), 'lessor_address', $tpl$Lessor address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 4),
  ((SELECT id FROM document_templates WHERE template_key = 'rent_agreement'), 'lessee_name', $tpl$Lessee (tenant) name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$deal.buyer_name$tpl$, NULL, $tpl$[]$tpl$::jsonb, 5),
  ((SELECT id FROM document_templates WHERE template_key = 'rent_agreement'), 'lessee_address', $tpl$Lessee address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 6),
  ((SELECT id FROM document_templates WHERE template_key = 'rent_agreement'), 'property_address', $tpl$Property address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, $tpl$Full address as in the title documents$tpl$, $tpl$property.address$tpl$, NULL, $tpl$[]$tpl$::jsonb, 7),
  ((SELECT id FROM document_templates WHERE template_key = 'rent_agreement'), 'property_description', $tpl$Property description$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, $tpl$Type, floor, area, boundaries$tpl$, $tpl$property.description$tpl$, NULL, $tpl$[]$tpl$::jsonb, 8),
  ((SELECT id FROM document_templates WHERE template_key = 'rent_agreement'), 'lease_term', $tpl$Lease term$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, $tpl$e.g. 11 months, 3 years$tpl$, NULL, NULL, $tpl$[]$tpl$::jsonb, 9),
  ((SELECT id FROM document_templates WHERE template_key = 'rent_agreement'), 'lease_start_date', $tpl$Lease start date$tpl$, 'date', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 10),
  ((SELECT id FROM document_templates WHERE template_key = 'rent_agreement'), 'monthly_rent', $tpl$Monthly rent$tpl$, 'currency', $tpl$[]$tpl$::jsonb, $tpl${"min": 1}$tpl$::jsonb, true, NULL, $tpl$deal.value$tpl$, NULL, $tpl$[]$tpl$::jsonb, 11),
  ((SELECT id FROM document_templates WHERE template_key = 'rent_agreement'), 'monthly_rent_words', $tpl$monthly rent in words$tpl$, 'computed', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, $tpl${"of": "monthly_rent", "kind": "amount_in_words"}$tpl$::jsonb, $tpl$[]$tpl$::jsonb, 12),
  ((SELECT id FROM document_templates WHERE template_key = 'rent_agreement'), 'rent_due_day', $tpl$Rent due on day of month$tpl$, 'number', $tpl$[]$tpl$::jsonb, $tpl${"max": 28, "min": 1}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 13),
  ((SELECT id FROM document_templates WHERE template_key = 'rent_agreement'), 'security_deposit', $tpl$Security deposit$tpl$, 'currency', $tpl$[]$tpl$::jsonb, $tpl${"min": 1}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 14),
  ((SELECT id FROM document_templates WHERE template_key = 'rent_agreement'), 'security_deposit_words', $tpl$security deposit in words$tpl$, 'computed', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, $tpl${"of": "security_deposit", "kind": "amount_in_words"}$tpl$::jsonb, $tpl$[]$tpl$::jsonb, 15),
  ((SELECT id FROM document_templates WHERE template_key = 'rent_agreement'), 'escalation_percent', $tpl$Rent escalation (%)$tpl$, 'number', $tpl$[]$tpl$::jsonb, $tpl${"max": 50, "min": 0}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 16),
  ((SELECT id FROM document_templates WHERE template_key = 'rent_agreement'), 'escalation_months', $tpl$Escalation every (months)$tpl$, 'number', $tpl$[]$tpl$::jsonb, $tpl${"max": 120, "min": 1}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 17),
  ((SELECT id FROM document_templates WHERE template_key = 'rent_agreement'), 'permitted_use', $tpl$Permitted use$tpl$, 'dropdown', $tpl$["residential", "commercial"]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 18),
  ((SELECT id FROM document_templates WHERE template_key = 'rent_agreement'), 'notice_period', $tpl$Notice period$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, $tpl$e.g. one month$tpl$, NULL, NULL, $tpl$[]$tpl$::jsonb, 19),
  ((SELECT id FROM document_templates WHERE template_key = 'rent_agreement'), 'lock_in_period', $tpl$Lock-in period$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, $tpl$e.g. six months, or nil$tpl$, NULL, NULL, $tpl$[]$tpl$::jsonb, 20),
  ((SELECT id FROM document_templates WHERE template_key = 'rent_agreement'), 'witness_1_name', $tpl$Witness 1 name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 21),
  ((SELECT id FROM document_templates WHERE template_key = 'rent_agreement'), 'witness_2_name', $tpl$Witness 2 name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 22)
ON CONFLICT (template_id, name) DO NOTHING;

INSERT INTO document_templates (template_key, name, category, description, audience, duty_transaction, status, current_version, sort_order) VALUES ('leave_and_licence', $tpl$Leave & Licence Agreement$tpl$, 'lease', $tpl$Leave and licence for use of premises without creating a tenancy.$tpl$, 'all', 'lease', 'active', 1, 4) ON CONFLICT (template_key) DO NOTHING;
INSERT INTO document_template_versions (template_id, version, body, state_blocks, change_note) VALUES ((SELECT id FROM document_templates WHERE template_key = 'leave_and_licence'), 1, $tpl$# Leave and Licence Agreement

This Agreement is made at {{execution_place}} on this {{execution_date}}

## Between

{{licensor_name}}, residing at {{licensor_address}} (the "Licensor")

## And

{{licensee_name}}, residing at {{licensee_address}} (the "Licensee").

## Licensed Premises

The premises situated at {{property_address}}, being {{property_description}}.

## 1. Licence

The Licensor grants the Licensee leave and licence to use and occupy the Licensed Premises for {{permitted_use}} purposes for a period of {{licence_period}} commencing on {{licence_start_date}}. Nothing in this Agreement creates a tenancy, lease or any interest in the Licensed Premises in favour of the Licensee.

## 2. Licence fee

The Licensee shall pay a monthly licence fee of {{monthly_rent}} ({{monthly_rent_words}}) on or before the {{rent_due_day}} day of each month.

## 3. Deposit

The Licensee has paid an interest-free refundable deposit of {{security_deposit}} ({{security_deposit_words}}).

## 4. Obligations of the Licensee

The Licensee shall use the Licensed Premises with care, pay electricity and other consumption charges, follow the rules of the society, and hand back the Licensed Premises in the same condition on expiry, reasonable wear and tear excepted.

## 5. Termination

Either party may revoke this licence by giving {{notice_period}} written notice. On expiry or revocation the Licensee shall remove himself and his belongings from the Licensed Premises.

## Witnesses

IN WITNESS WHEREOF the parties have signed this document on the date first written above in the presence of the following witnesses.

Witness 1: {{witness_1_name}}

Witness 2: {{witness_2_name}}$tpl$, $tpl$[]$tpl$::jsonb, 'Launch library') ON CONFLICT (template_id, version) DO NOTHING;
INSERT INTO template_variables (template_id, name, label, field_type, options, validation, is_required, help_text, prefill, computed, state_codes, sort_order) VALUES
  ((SELECT id FROM document_templates WHERE template_key = 'leave_and_licence'), 'execution_place', $tpl$Place of execution$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$property.city$tpl$, NULL, $tpl$[]$tpl$::jsonb, 1),
  ((SELECT id FROM document_templates WHERE template_key = 'leave_and_licence'), 'execution_date', $tpl$Date of execution$tpl$, 'date', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 2),
  ((SELECT id FROM document_templates WHERE template_key = 'leave_and_licence'), 'licensor_name', $tpl$Licensor (owner) name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$deal.seller_name$tpl$, NULL, $tpl$[]$tpl$::jsonb, 3),
  ((SELECT id FROM document_templates WHERE template_key = 'leave_and_licence'), 'licensor_address', $tpl$Licensor address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 4),
  ((SELECT id FROM document_templates WHERE template_key = 'leave_and_licence'), 'licensee_name', $tpl$Licensee name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$deal.buyer_name$tpl$, NULL, $tpl$[]$tpl$::jsonb, 5),
  ((SELECT id FROM document_templates WHERE template_key = 'leave_and_licence'), 'licensee_address', $tpl$Licensee address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 6),
  ((SELECT id FROM document_templates WHERE template_key = 'leave_and_licence'), 'property_address', $tpl$Property address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, $tpl$Full address as in the title documents$tpl$, $tpl$property.address$tpl$, NULL, $tpl$[]$tpl$::jsonb, 7),
  ((SELECT id FROM document_templates WHERE template_key = 'leave_and_licence'), 'property_description', $tpl$Property description$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, $tpl$Type, floor, area, boundaries$tpl$, $tpl$property.description$tpl$, NULL, $tpl$[]$tpl$::jsonb, 8),
  ((SELECT id FROM document_templates WHERE template_key = 'leave_and_licence'), 'permitted_use', $tpl$Use$tpl$, 'dropdown', $tpl$["residential", "commercial"]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 9),
  ((SELECT id FROM document_templates WHERE template_key = 'leave_and_licence'), 'licence_period', $tpl$Licence period$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, $tpl$e.g. 11 months$tpl$, NULL, NULL, $tpl$[]$tpl$::jsonb, 10),
  ((SELECT id FROM document_templates WHERE template_key = 'leave_and_licence'), 'licence_start_date', $tpl$Licence start date$tpl$, 'date', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 11),
  ((SELECT id FROM document_templates WHERE template_key = 'leave_and_licence'), 'monthly_rent', $tpl$Monthly licence fee$tpl$, 'currency', $tpl$[]$tpl$::jsonb, $tpl${"min": 1}$tpl$::jsonb, true, NULL, $tpl$deal.value$tpl$, NULL, $tpl$[]$tpl$::jsonb, 12),
  ((SELECT id FROM document_templates WHERE template_key = 'leave_and_licence'), 'monthly_rent_words', $tpl$monthly rent in words$tpl$, 'computed', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, $tpl${"of": "monthly_rent", "kind": "amount_in_words"}$tpl$::jsonb, $tpl$[]$tpl$::jsonb, 13),
  ((SELECT id FROM document_templates WHERE template_key = 'leave_and_licence'), 'rent_due_day', $tpl$Fee due on day of month$tpl$, 'number', $tpl$[]$tpl$::jsonb, $tpl${"max": 28, "min": 1}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 14),
  ((SELECT id FROM document_templates WHERE template_key = 'leave_and_licence'), 'security_deposit', $tpl$Deposit$tpl$, 'currency', $tpl$[]$tpl$::jsonb, $tpl${"min": 1}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 15),
  ((SELECT id FROM document_templates WHERE template_key = 'leave_and_licence'), 'security_deposit_words', $tpl$security deposit in words$tpl$, 'computed', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, $tpl${"of": "security_deposit", "kind": "amount_in_words"}$tpl$::jsonb, $tpl$[]$tpl$::jsonb, 16),
  ((SELECT id FROM document_templates WHERE template_key = 'leave_and_licence'), 'notice_period', $tpl$Notice period$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 17),
  ((SELECT id FROM document_templates WHERE template_key = 'leave_and_licence'), 'witness_1_name', $tpl$Witness 1 name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 18),
  ((SELECT id FROM document_templates WHERE template_key = 'leave_and_licence'), 'witness_2_name', $tpl$Witness 2 name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 19)
ON CONFLICT (template_id, name) DO NOTHING;

INSERT INTO document_templates (template_key, name, category, description, audience, duty_transaction, status, current_version, sort_order) VALUES ('memorandum_of_understanding', $tpl$Memorandum of Understanding$tpl$, 'general', $tpl$Non-binding understanding between two parties ahead of a definitive agreement.$tpl$, 'professional', 'sale', 'active', 1, 5) ON CONFLICT (template_key) DO NOTHING;
INSERT INTO document_template_versions (template_id, version, body, state_blocks, change_note) VALUES ((SELECT id FROM document_templates WHERE template_key = 'memorandum_of_understanding'), 1, $tpl$# Memorandum of Understanding

This Memorandum of Understanding is made at {{execution_place}} on this {{execution_date}}

## Between

{{first_party_name}}, having its address at {{first_party_address}} (the "First Party")

## And

{{second_party_name}}, having its address at {{second_party_address}} (the "Second Party").

## 1. Purpose

The parties record their understanding in relation to {{purpose}}.

## 2. Property

Where this understanding concerns immovable property, it relates to {{property_address}}.

## 3. Commercial understanding

{{commercial_terms}}

## 4. Validity

This Memorandum is valid for {{validity_period}} from its date, within which the parties intend to execute a definitive agreement.

## 5. Confidentiality

Each party shall keep the terms of this Memorandum and all information exchanged under it confidential.

## 6. Nature

Save for the clauses on confidentiality and governing law, this Memorandum records an intention only and does not bind either party to conclude the transaction.

## 7. Governing law

This Memorandum is governed by the laws of India and the courts at {{jurisdiction_city}} have jurisdiction.

## Witnesses

IN WITNESS WHEREOF the parties have signed this document on the date first written above in the presence of the following witnesses.

Witness 1: {{witness_1_name}}

Witness 2: {{witness_2_name}}$tpl$, $tpl$[]$tpl$::jsonb, 'Launch library') ON CONFLICT (template_id, version) DO NOTHING;
INSERT INTO template_variables (template_id, name, label, field_type, options, validation, is_required, help_text, prefill, computed, state_codes, sort_order) VALUES
  ((SELECT id FROM document_templates WHERE template_key = 'memorandum_of_understanding'), 'execution_place', $tpl$Place of execution$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$property.city$tpl$, NULL, $tpl$[]$tpl$::jsonb, 1),
  ((SELECT id FROM document_templates WHERE template_key = 'memorandum_of_understanding'), 'execution_date', $tpl$Date of execution$tpl$, 'date', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 2),
  ((SELECT id FROM document_templates WHERE template_key = 'memorandum_of_understanding'), 'first_party_name', $tpl$First party$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$deal.seller_name$tpl$, NULL, $tpl$[]$tpl$::jsonb, 3),
  ((SELECT id FROM document_templates WHERE template_key = 'memorandum_of_understanding'), 'first_party_address', $tpl$First party address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 4),
  ((SELECT id FROM document_templates WHERE template_key = 'memorandum_of_understanding'), 'second_party_name', $tpl$Second party$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$deal.buyer_name$tpl$, NULL, $tpl$[]$tpl$::jsonb, 5),
  ((SELECT id FROM document_templates WHERE template_key = 'memorandum_of_understanding'), 'second_party_address', $tpl$Second party address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 6),
  ((SELECT id FROM document_templates WHERE template_key = 'memorandum_of_understanding'), 'purpose', $tpl$Purpose of the understanding$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 7),
  ((SELECT id FROM document_templates WHERE template_key = 'memorandum_of_understanding'), 'property_address', $tpl$Property address (if any)$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, $tpl$property.address$tpl$, NULL, $tpl$[]$tpl$::jsonb, 8),
  ((SELECT id FROM document_templates WHERE template_key = 'memorandum_of_understanding'), 'commercial_terms', $tpl$Commercial understanding$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 9),
  ((SELECT id FROM document_templates WHERE template_key = 'memorandum_of_understanding'), 'validity_period', $tpl$Valid for$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, $tpl$e.g. 60 days$tpl$, NULL, NULL, $tpl$[]$tpl$::jsonb, 10),
  ((SELECT id FROM document_templates WHERE template_key = 'memorandum_of_understanding'), 'jurisdiction_city', $tpl$Jurisdiction (city)$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$property.city$tpl$, NULL, $tpl$[]$tpl$::jsonb, 11),
  ((SELECT id FROM document_templates WHERE template_key = 'memorandum_of_understanding'), 'witness_1_name', $tpl$Witness 1 name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 12),
  ((SELECT id FROM document_templates WHERE template_key = 'memorandum_of_understanding'), 'witness_2_name', $tpl$Witness 2 name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 13)
ON CONFLICT (template_id, name) DO NOTHING;

INSERT INTO document_templates (template_key, name, category, description, audience, duty_transaction, status, current_version, sort_order) VALUES ('general_power_of_attorney', $tpl$General Power of Attorney$tpl$, 'authority', $tpl$General power of attorney to manage and deal with a property.$tpl$, 'professional', 'sale', 'active', 1, 6) ON CONFLICT (template_key) DO NOTHING;
INSERT INTO document_template_versions (template_id, version, body, state_blocks, change_note) VALUES ((SELECT id FROM document_templates WHERE template_key = 'general_power_of_attorney'), 1, $tpl$# General Power of Attorney

KNOW ALL BY THESE PRESENTS that I, {{principal_name}}, {{principal_parent_name}}, residing at {{principal_address}} (the "Principal"), do hereby appoint {{attorney_name}}, {{attorney_parent_name}}, residing at {{attorney_address}} (the "Attorney"), as my true and lawful attorney to do the following acts in my name and on my behalf in respect of the property situated at {{property_address}} (the "Property").

## Powers

1. To manage, supervise and look after the Property and to pay all taxes, charges and outgoings on it.

2. To let out the Property, to receive rent and to issue receipts.

3. To apply for and obtain mutation, water, electricity and other connections, and to appear before any municipal, revenue or government authority.

4. To appear before any court, tribunal or authority in matters concerning the Property and to engage advocates.

5. To negotiate for the sale of the Property, to receive consideration, and to execute and present for registration an agreement or deed of sale, subject to the law in force.

6. Generally to do all acts necessary for the above purposes.

## Ratification

I agree to ratify and confirm all lawful acts done by the Attorney under this Power of Attorney. This Power of Attorney is {{revocability}} and remains in force until {{valid_until}}.

Executed at {{execution_place}} on this {{execution_date}}.

## Witnesses

IN WITNESS WHEREOF the parties have signed this document on the date first written above in the presence of the following witnesses.

Witness 1: {{witness_1_name}}

Witness 2: {{witness_2_name}}$tpl$, $tpl$[]$tpl$::jsonb, 'Launch library') ON CONFLICT (template_id, version) DO NOTHING;
INSERT INTO template_variables (template_id, name, label, field_type, options, validation, is_required, help_text, prefill, computed, state_codes, sort_order) VALUES
  ((SELECT id FROM document_templates WHERE template_key = 'general_power_of_attorney'), 'principal_name', $tpl$Principal (owner) name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$deal.seller_name$tpl$, NULL, $tpl$[]$tpl$::jsonb, 1),
  ((SELECT id FROM document_templates WHERE template_key = 'general_power_of_attorney'), 'principal_parent_name', $tpl$Principal: son / daughter / wife of$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 2),
  ((SELECT id FROM document_templates WHERE template_key = 'general_power_of_attorney'), 'principal_address', $tpl$Principal address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 3),
  ((SELECT id FROM document_templates WHERE template_key = 'general_power_of_attorney'), 'attorney_name', $tpl$Attorney name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 4),
  ((SELECT id FROM document_templates WHERE template_key = 'general_power_of_attorney'), 'attorney_parent_name', $tpl$Attorney: son / daughter / wife of$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 5),
  ((SELECT id FROM document_templates WHERE template_key = 'general_power_of_attorney'), 'attorney_address', $tpl$Attorney address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 6),
  ((SELECT id FROM document_templates WHERE template_key = 'general_power_of_attorney'), 'property_address', $tpl$Property address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$property.address$tpl$, NULL, $tpl$[]$tpl$::jsonb, 7),
  ((SELECT id FROM document_templates WHERE template_key = 'general_power_of_attorney'), 'revocability', $tpl$Revocable?$tpl$, 'dropdown', $tpl$["revocable", "irrevocable"]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 8),
  ((SELECT id FROM document_templates WHERE template_key = 'general_power_of_attorney'), 'valid_until', $tpl$In force until$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, $tpl$a date, or "revoked in writing"$tpl$, NULL, NULL, $tpl$[]$tpl$::jsonb, 9),
  ((SELECT id FROM document_templates WHERE template_key = 'general_power_of_attorney'), 'execution_place', $tpl$Place of execution$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$property.city$tpl$, NULL, $tpl$[]$tpl$::jsonb, 10),
  ((SELECT id FROM document_templates WHERE template_key = 'general_power_of_attorney'), 'execution_date', $tpl$Date of execution$tpl$, 'date', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 11),
  ((SELECT id FROM document_templates WHERE template_key = 'general_power_of_attorney'), 'witness_1_name', $tpl$Witness 1 name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 12),
  ((SELECT id FROM document_templates WHERE template_key = 'general_power_of_attorney'), 'witness_2_name', $tpl$Witness 2 name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 13)
ON CONFLICT (template_id, name) DO NOTHING;

INSERT INTO document_templates (template_key, name, category, description, audience, duty_transaction, status, current_version, sort_order) VALUES ('specific_power_of_attorney', $tpl$Specific Power of Attorney$tpl$, 'authority', $tpl$Power of attorney limited to one stated act.$tpl$, 'professional', 'sale', 'active', 1, 7) ON CONFLICT (template_key) DO NOTHING;
INSERT INTO document_template_versions (template_id, version, body, state_blocks, change_note) VALUES ((SELECT id FROM document_templates WHERE template_key = 'specific_power_of_attorney'), 1, $tpl$# Specific Power of Attorney

KNOW ALL BY THESE PRESENTS that I, {{principal_name}}, {{principal_parent_name}}, residing at {{principal_address}} (the "Principal"), do hereby appoint {{attorney_name}}, residing at {{attorney_address}} (the "Attorney"), as my lawful attorney for the specific purpose stated below in respect of the property situated at {{property_address}}.

## Specific purpose

{{specific_purpose}}

## Limits

This Power of Attorney is confined to the purpose stated above and to acts incidental to it. It does not authorise the Attorney to sell, mortgage or otherwise transfer the property unless that is the stated purpose.

## Validity

This Power of Attorney remains in force until {{valid_until}} or until the purpose is completed, whichever is earlier, and I agree to ratify all lawful acts done under it.

Executed at {{execution_place}} on this {{execution_date}}.

## Witnesses

IN WITNESS WHEREOF the parties have signed this document on the date first written above in the presence of the following witnesses.

Witness 1: {{witness_1_name}}

Witness 2: {{witness_2_name}}$tpl$, $tpl$[]$tpl$::jsonb, 'Launch library') ON CONFLICT (template_id, version) DO NOTHING;
INSERT INTO template_variables (template_id, name, label, field_type, options, validation, is_required, help_text, prefill, computed, state_codes, sort_order) VALUES
  ((SELECT id FROM document_templates WHERE template_key = 'specific_power_of_attorney'), 'principal_name', $tpl$Principal name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$deal.seller_name$tpl$, NULL, $tpl$[]$tpl$::jsonb, 1),
  ((SELECT id FROM document_templates WHERE template_key = 'specific_power_of_attorney'), 'principal_parent_name', $tpl$Principal: son / daughter / wife of$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 2),
  ((SELECT id FROM document_templates WHERE template_key = 'specific_power_of_attorney'), 'principal_address', $tpl$Principal address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 3),
  ((SELECT id FROM document_templates WHERE template_key = 'specific_power_of_attorney'), 'attorney_name', $tpl$Attorney name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 4),
  ((SELECT id FROM document_templates WHERE template_key = 'specific_power_of_attorney'), 'attorney_address', $tpl$Attorney address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 5),
  ((SELECT id FROM document_templates WHERE template_key = 'specific_power_of_attorney'), 'property_address', $tpl$Property address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$property.address$tpl$, NULL, $tpl$[]$tpl$::jsonb, 6),
  ((SELECT id FROM document_templates WHERE template_key = 'specific_power_of_attorney'), 'specific_purpose', $tpl$The specific act authorised$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, $tpl$e.g. to present the Sale Deed for registration before the Sub-Registrar$tpl$, NULL, NULL, $tpl$[]$tpl$::jsonb, 7),
  ((SELECT id FROM document_templates WHERE template_key = 'specific_power_of_attorney'), 'valid_until', $tpl$In force until$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 8),
  ((SELECT id FROM document_templates WHERE template_key = 'specific_power_of_attorney'), 'execution_place', $tpl$Place of execution$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$property.city$tpl$, NULL, $tpl$[]$tpl$::jsonb, 9),
  ((SELECT id FROM document_templates WHERE template_key = 'specific_power_of_attorney'), 'execution_date', $tpl$Date of execution$tpl$, 'date', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 10),
  ((SELECT id FROM document_templates WHERE template_key = 'specific_power_of_attorney'), 'witness_1_name', $tpl$Witness 1 name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 11),
  ((SELECT id FROM document_templates WHERE template_key = 'specific_power_of_attorney'), 'witness_2_name', $tpl$Witness 2 name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 12)
ON CONFLICT (template_id, name) DO NOTHING;

INSERT INTO document_templates (template_key, name, category, description, audience, duty_transaction, status, current_version, sort_order) VALUES ('joint_development_agreement', $tpl$Joint Development Agreement$tpl$, 'development', $tpl$Land owner and developer agree to develop land and share the built-up area.$tpl$, 'staff', 'sale', 'active', 1, 8) ON CONFLICT (template_key) DO NOTHING;
INSERT INTO document_template_versions (template_id, version, body, state_blocks, change_note) VALUES ((SELECT id FROM document_templates WHERE template_key = 'joint_development_agreement'), 1, $tpl$# Joint Development Agreement

This Joint Development Agreement is made at {{execution_place}} on this {{execution_date}}

## Between

{{owner_name}}, having address at {{owner_address}} (the "Owner")

## And

{{developer_name}}, having its office at {{developer_address}} (the "Developer").

## Land

The land admeasuring {{land_area}} situated at {{property_address}} (the "Land").

{{state_clauses}}

## 1. Development

The Owner permits the Developer to develop the Land at the Developer's cost by constructing {{project_description}} in accordance with the sanctioned plan and the applicable law, including registration under the Real Estate (Regulation and Development) Act, 2016.

## 2. Sharing

The built-up area shall be shared in the ratio of {{owner_share_percent}} percent to the Owner and {{developer_share_percent}} percent to the Developer.

## 3. Deposit

The Developer has paid the Owner a refundable deposit of {{refundable_deposit}} ({{refundable_deposit_words}}).

## 4. Time

The Developer shall complete the development within {{completion_period}} from the date of sanction of plans, with a grace period of {{grace_period}}.

## 5. Approvals and cost

All approvals shall be obtained by the Developer at its cost. The Owner shall sign all papers required for the purpose.

## 6. Title

The Owner declares that the Land is free from encumbrances and litigation and that the Owner has marketable title.

## 7. Delay

For delay beyond the grace period the Developer shall pay the Owner {{delay_compensation}} per month.

## Witnesses

IN WITNESS WHEREOF the parties have signed this document on the date first written above in the presence of the following witnesses.

Witness 1: {{witness_1_name}}

Witness 2: {{witness_2_name}}$tpl$, $tpl$[{"body": "## Karnataka particulars\n\nThe Scheduled Property bears Khata No. {{khata_number}} and Survey No. {{survey_number}} in the records of the jurisdictional authority.", "stateCode": "KA"}, {"body": "## Tamil Nadu particulars\n\nThe Scheduled Property is comprised in Patta No. {{patta_number}} and Survey No. {{survey_number}} in the revenue records.", "stateCode": "TN"}, {"body": "## Delhi particulars\n\nWhere the Scheduled Property lies within Lal Dora / extended Lal Dora, the certificate bearing No. {{lal_dora_certificate}} issued by the competent authority forms part of the title papers.", "stateCode": "DL"}]$tpl$::jsonb, 'Launch library') ON CONFLICT (template_id, version) DO NOTHING;
INSERT INTO template_variables (template_id, name, label, field_type, options, validation, is_required, help_text, prefill, computed, state_codes, sort_order) VALUES
  ((SELECT id FROM document_templates WHERE template_key = 'joint_development_agreement'), 'execution_place', $tpl$Place of execution$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$property.city$tpl$, NULL, $tpl$[]$tpl$::jsonb, 1),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_development_agreement'), 'execution_date', $tpl$Date of execution$tpl$, 'date', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 2),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_development_agreement'), 'owner_name', $tpl$Land owner$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$deal.seller_name$tpl$, NULL, $tpl$[]$tpl$::jsonb, 3),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_development_agreement'), 'owner_address', $tpl$Owner address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 4),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_development_agreement'), 'developer_name', $tpl$Developer$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$deal.buyer_name$tpl$, NULL, $tpl$[]$tpl$::jsonb, 5),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_development_agreement'), 'developer_address', $tpl$Developer office address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 6),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_development_agreement'), 'land_area', $tpl$Land area$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, $tpl$e.g. 2 acres, 4,000 sq m$tpl$, NULL, NULL, $tpl$[]$tpl$::jsonb, 7),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_development_agreement'), 'property_address', $tpl$Land address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$property.address$tpl$, NULL, $tpl$[]$tpl$::jsonb, 8),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_development_agreement'), 'project_description', $tpl$What will be built$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 9),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_development_agreement'), 'owner_share_percent', $tpl$Owner share (%)$tpl$, 'number', $tpl$[]$tpl$::jsonb, $tpl${"max": 100, "min": 0}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 10),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_development_agreement'), 'developer_share_percent', $tpl$Developer share (%)$tpl$, 'number', $tpl$[]$tpl$::jsonb, $tpl${"max": 100, "min": 0}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 11),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_development_agreement'), 'refundable_deposit', $tpl$Refundable deposit$tpl$, 'currency', $tpl$[]$tpl$::jsonb, $tpl${"min": 1}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 12),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_development_agreement'), 'refundable_deposit_words', $tpl$refundable deposit in words$tpl$, 'computed', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, $tpl${"of": "refundable_deposit", "kind": "amount_in_words"}$tpl$::jsonb, $tpl$[]$tpl$::jsonb, 13),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_development_agreement'), 'completion_period', $tpl$Completion period$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, $tpl$e.g. 36 months$tpl$, NULL, NULL, $tpl$[]$tpl$::jsonb, 14),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_development_agreement'), 'grace_period', $tpl$Grace period$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 15),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_development_agreement'), 'delay_compensation', $tpl$Compensation for delay, per month$tpl$, 'currency', $tpl$[]$tpl$::jsonb, $tpl${"min": 1}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 16),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_development_agreement'), 'khata_number', $tpl$Khata number$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, $tpl$From the BBMP / panchayat khata certificate$tpl$, NULL, NULL, $tpl$["KA"]$tpl$::jsonb, 17),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_development_agreement'), 'patta_number', $tpl$Patta number$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$["TN"]$tpl$::jsonb, 18),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_development_agreement'), 'survey_number', $tpl$Survey number$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$["KA", "TN", "AP", "TS", "MH", "GJ"]$tpl$::jsonb, 19),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_development_agreement'), 'lal_dora_certificate', $tpl$Lal Dora certificate number$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$["DL"]$tpl$::jsonb, 20),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_development_agreement'), 'witness_1_name', $tpl$Witness 1 name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 21),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_development_agreement'), 'witness_2_name', $tpl$Witness 2 name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 22)
ON CONFLICT (template_id, name) DO NOTHING;

INSERT INTO document_templates (template_key, name, category, description, audience, duty_transaction, status, current_version, sort_order) VALUES ('joint_venture_agreement', $tpl$Joint Venture Agreement$tpl$, 'development', $tpl$Two parties pool resources for a real-estate project and share profit.$tpl$, 'staff', 'sale', 'active', 1, 9) ON CONFLICT (template_key) DO NOTHING;
INSERT INTO document_template_versions (template_id, version, body, state_blocks, change_note) VALUES ((SELECT id FROM document_templates WHERE template_key = 'joint_venture_agreement'), 1, $tpl$# Joint Venture Agreement

This Joint Venture Agreement is made at {{execution_place}} on this {{execution_date}}

## Between

{{first_party_name}}, having address at {{first_party_address}} (the "First Party")

## And

{{second_party_name}}, having address at {{second_party_address}} (the "Second Party").

## 1. Venture

The parties agree to undertake jointly the project described as {{project_description}} at {{property_address}} (the "Project").

## 2. Contribution

The First Party shall contribute {{first_party_contribution}} and the Second Party shall contribute {{second_party_contribution}}.

## 3. Profit and loss

Profit and loss of the Project shall be shared in the ratio of {{first_party_share_percent}} percent to the First Party and {{second_party_share_percent}} percent to the Second Party.

## 4. Management

The Project shall be managed by {{managing_party}}. Decisions on sale price, borrowing and change of plans require the written consent of both parties.

## 5. Accounts

Proper books of account shall be kept and shall be open to both parties. A separate bank account shall be operated for the Project.

## 6. Term

This Agreement continues until the Project is completed and the accounts are settled, expected within {{project_period}}.

## 7. Exit

Neither party shall transfer its interest in the Project without the written consent of the other.

## Witnesses

IN WITNESS WHEREOF the parties have signed this document on the date first written above in the presence of the following witnesses.

Witness 1: {{witness_1_name}}

Witness 2: {{witness_2_name}}$tpl$, $tpl$[]$tpl$::jsonb, 'Launch library') ON CONFLICT (template_id, version) DO NOTHING;
INSERT INTO template_variables (template_id, name, label, field_type, options, validation, is_required, help_text, prefill, computed, state_codes, sort_order) VALUES
  ((SELECT id FROM document_templates WHERE template_key = 'joint_venture_agreement'), 'execution_place', $tpl$Place of execution$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$property.city$tpl$, NULL, $tpl$[]$tpl$::jsonb, 1),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_venture_agreement'), 'execution_date', $tpl$Date of execution$tpl$, 'date', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 2),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_venture_agreement'), 'first_party_name', $tpl$First party$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$deal.seller_name$tpl$, NULL, $tpl$[]$tpl$::jsonb, 3),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_venture_agreement'), 'first_party_address', $tpl$First party address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 4),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_venture_agreement'), 'second_party_name', $tpl$Second party$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$deal.buyer_name$tpl$, NULL, $tpl$[]$tpl$::jsonb, 5),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_venture_agreement'), 'second_party_address', $tpl$Second party address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 6),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_venture_agreement'), 'project_description', $tpl$Project$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 7),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_venture_agreement'), 'property_address', $tpl$Project location$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$property.address$tpl$, NULL, $tpl$[]$tpl$::jsonb, 8),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_venture_agreement'), 'first_party_contribution', $tpl$First party contributes$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 9),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_venture_agreement'), 'second_party_contribution', $tpl$Second party contributes$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 10),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_venture_agreement'), 'first_party_share_percent', $tpl$First party share (%)$tpl$, 'number', $tpl$[]$tpl$::jsonb, $tpl${"max": 100, "min": 0}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 11),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_venture_agreement'), 'second_party_share_percent', $tpl$Second party share (%)$tpl$, 'number', $tpl$[]$tpl$::jsonb, $tpl${"max": 100, "min": 0}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 12),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_venture_agreement'), 'managing_party', $tpl$Managed by$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 13),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_venture_agreement'), 'project_period', $tpl$Expected project period$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 14),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_venture_agreement'), 'witness_1_name', $tpl$Witness 1 name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 15),
  ((SELECT id FROM document_templates WHERE template_key = 'joint_venture_agreement'), 'witness_2_name', $tpl$Witness 2 name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 16)
ON CONFLICT (template_id, name) DO NOTHING;

INSERT INTO document_templates (template_key, name, category, description, audience, duty_transaction, status, current_version, sort_order) VALUES ('development_agreement', $tpl$Development Agreement$tpl$, 'development', $tpl$Owner appoints a developer to develop land for a consideration.$tpl$, 'staff', 'sale', 'active', 1, 10) ON CONFLICT (template_key) DO NOTHING;
INSERT INTO document_template_versions (template_id, version, body, state_blocks, change_note) VALUES ((SELECT id FROM document_templates WHERE template_key = 'development_agreement'), 1, $tpl$# Development Agreement

This Development Agreement is made at {{execution_place}} on this {{execution_date}}

## Between

{{owner_name}}, having address at {{owner_address}} (the "Owner")

## And

{{developer_name}}, having its office at {{developer_address}} (the "Developer").

## Property

The property admeasuring {{land_area}} situated at {{property_address}} (the "Property").

{{state_clauses}}

## 1. Grant of development rights

The Owner grants the Developer the right to develop the Property by constructing {{project_description}} at the Developer's cost and risk.

## 2. Consideration

In consideration of the development rights the Developer shall pay the Owner {{development_consideration}} ({{development_consideration_words}}) as follows: {{payment_schedule}}.

## 3. Approvals

The Developer shall obtain all sanctions and shall comply with the Real Estate (Regulation and Development) Act, 2016 and all other applicable laws.

## 4. Completion

The development shall be completed within {{completion_period}} from the date of commencement.

## 5. Owner's assurances

The Owner declares that the Property has clear and marketable title and is free from encumbrances, and shall execute a power of attorney in favour of the Developer for the purposes of the development.

## 6. Stamp duty

Stamp duty of {{stamp_duty_amount}}, indicative as per the rules of the State, and registration charges on this Agreement shall be borne by the Developer.

## Witnesses

IN WITNESS WHEREOF the parties have signed this document on the date first written above in the presence of the following witnesses.

Witness 1: {{witness_1_name}}

Witness 2: {{witness_2_name}}$tpl$, $tpl$[{"body": "## Karnataka particulars\n\nThe Scheduled Property bears Khata No. {{khata_number}} and Survey No. {{survey_number}} in the records of the jurisdictional authority.", "stateCode": "KA"}, {"body": "## Tamil Nadu particulars\n\nThe Scheduled Property is comprised in Patta No. {{patta_number}} and Survey No. {{survey_number}} in the revenue records.", "stateCode": "TN"}, {"body": "## Delhi particulars\n\nWhere the Scheduled Property lies within Lal Dora / extended Lal Dora, the certificate bearing No. {{lal_dora_certificate}} issued by the competent authority forms part of the title papers.", "stateCode": "DL"}]$tpl$::jsonb, 'Launch library') ON CONFLICT (template_id, version) DO NOTHING;
INSERT INTO template_variables (template_id, name, label, field_type, options, validation, is_required, help_text, prefill, computed, state_codes, sort_order) VALUES
  ((SELECT id FROM document_templates WHERE template_key = 'development_agreement'), 'execution_place', $tpl$Place of execution$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$property.city$tpl$, NULL, $tpl$[]$tpl$::jsonb, 1),
  ((SELECT id FROM document_templates WHERE template_key = 'development_agreement'), 'execution_date', $tpl$Date of execution$tpl$, 'date', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 2),
  ((SELECT id FROM document_templates WHERE template_key = 'development_agreement'), 'owner_name', $tpl$Owner$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$deal.seller_name$tpl$, NULL, $tpl$[]$tpl$::jsonb, 3),
  ((SELECT id FROM document_templates WHERE template_key = 'development_agreement'), 'owner_address', $tpl$Owner address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 4),
  ((SELECT id FROM document_templates WHERE template_key = 'development_agreement'), 'developer_name', $tpl$Developer$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$deal.buyer_name$tpl$, NULL, $tpl$[]$tpl$::jsonb, 5),
  ((SELECT id FROM document_templates WHERE template_key = 'development_agreement'), 'developer_address', $tpl$Developer office address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 6),
  ((SELECT id FROM document_templates WHERE template_key = 'development_agreement'), 'land_area', $tpl$Area of the property$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 7),
  ((SELECT id FROM document_templates WHERE template_key = 'development_agreement'), 'property_address', $tpl$Property address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$property.address$tpl$, NULL, $tpl$[]$tpl$::jsonb, 8),
  ((SELECT id FROM document_templates WHERE template_key = 'development_agreement'), 'project_description', $tpl$What will be built$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 9),
  ((SELECT id FROM document_templates WHERE template_key = 'development_agreement'), 'development_consideration', $tpl$Consideration$tpl$, 'currency', $tpl$[]$tpl$::jsonb, $tpl${"min": 1}$tpl$::jsonb, true, NULL, $tpl$deal.value$tpl$, NULL, $tpl$[]$tpl$::jsonb, 10),
  ((SELECT id FROM document_templates WHERE template_key = 'development_agreement'), 'development_consideration_words', $tpl$development consideration in words$tpl$, 'computed', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, $tpl${"of": "development_consideration", "kind": "amount_in_words"}$tpl$::jsonb, $tpl$[]$tpl$::jsonb, 11),
  ((SELECT id FROM document_templates WHERE template_key = 'development_agreement'), 'payment_schedule', $tpl$Payment schedule$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 12),
  ((SELECT id FROM document_templates WHERE template_key = 'development_agreement'), 'completion_period', $tpl$Completion period$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 13),
  ((SELECT id FROM document_templates WHERE template_key = 'development_agreement'), 'stamp_duty_amount', $tpl$Stamp duty (from the state rules)$tpl$, 'computed', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, $tpl${"of": "development_consideration", "kind": "stamp_duty"}$tpl$::jsonb, $tpl$[]$tpl$::jsonb, 14),
  ((SELECT id FROM document_templates WHERE template_key = 'development_agreement'), 'khata_number', $tpl$Khata number$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, $tpl$From the BBMP / panchayat khata certificate$tpl$, NULL, NULL, $tpl$["KA"]$tpl$::jsonb, 15),
  ((SELECT id FROM document_templates WHERE template_key = 'development_agreement'), 'patta_number', $tpl$Patta number$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$["TN"]$tpl$::jsonb, 16),
  ((SELECT id FROM document_templates WHERE template_key = 'development_agreement'), 'survey_number', $tpl$Survey number$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$["KA", "TN", "AP", "TS", "MH", "GJ"]$tpl$::jsonb, 17),
  ((SELECT id FROM document_templates WHERE template_key = 'development_agreement'), 'lal_dora_certificate', $tpl$Lal Dora certificate number$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$["DL"]$tpl$::jsonb, 18),
  ((SELECT id FROM document_templates WHERE template_key = 'development_agreement'), 'witness_1_name', $tpl$Witness 1 name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 19),
  ((SELECT id FROM document_templates WHERE template_key = 'development_agreement'), 'witness_2_name', $tpl$Witness 2 name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 20)
ON CONFLICT (template_id, name) DO NOTHING;

INSERT INTO document_templates (template_key, name, category, description, audience, duty_transaction, status, current_version, sort_order) VALUES ('builder_buyer_agreement', $tpl$Builder-Buyer Agreement$tpl$, 'sale', $tpl$Agreement for sale of a unit in a RERA-registered project.$tpl$, 'professional', 'sale', 'active', 1, 11) ON CONFLICT (template_key) DO NOTHING;
INSERT INTO document_template_versions (template_id, version, body, state_blocks, change_note) VALUES ((SELECT id FROM document_templates WHERE template_key = 'builder_buyer_agreement'), 1, $tpl$# Builder-Buyer Agreement

This Agreement for Sale is made at {{execution_place}} on this {{execution_date}}

## Between

{{builder_name}}, having its registered office at {{builder_address}} (the "Promoter")

## And

{{buyer_name}}, {{buyer_parent_name}}, residing at {{buyer_address}} (the "Allottee").

## Project

The project known as {{project_name}} at {{property_address}}, registered under the Real Estate (Regulation and Development) Act, 2016 with registration number {{rera_number}}.

## 1. Unit

The Promoter agrees to sell and the Allottee agrees to purchase unit number {{unit_number}} on the {{floor_number}} floor having a carpet area of {{carpet_area_sqft}} square feet, with {{parking_spaces}} parking space(s) (the "Unit").

## 2. Total price

The total price of the Unit is {{sale_consideration}} ({{sale_consideration_words}}), payable as per this schedule: {{payment_schedule}}.

## 3. Booking amount

The Allottee has paid a booking amount of {{token_amount}} ({{token_amount_words}}).

## 4. Possession

The Promoter shall hand over possession of the Unit on or before {{possession_date}}, subject to force majeure as defined in the Act.

## 5. Delay

For delay in possession the Promoter shall pay interest at the rate prescribed under the Act. For delay in payment the Allottee shall pay interest at the same rate.

## 6. Defect liability

The Promoter shall rectify structural defects brought to its notice within five years from the date of possession, as required by the Act.

## 7. Conveyance

On receipt of the total price the Promoter shall execute a conveyance deed in favour of the Allottee. Stamp duty of {{stamp_duty_amount}} and a registration fee of {{registration_fee_amount}}, indicative as per the rules of the State, shall be borne by the Allottee.

## Witnesses

IN WITNESS WHEREOF the parties have signed this document on the date first written above in the presence of the following witnesses.

Witness 1: {{witness_1_name}}

Witness 2: {{witness_2_name}}$tpl$, $tpl$[]$tpl$::jsonb, 'Launch library') ON CONFLICT (template_id, version) DO NOTHING;
INSERT INTO template_variables (template_id, name, label, field_type, options, validation, is_required, help_text, prefill, computed, state_codes, sort_order) VALUES
  ((SELECT id FROM document_templates WHERE template_key = 'builder_buyer_agreement'), 'execution_place', $tpl$Place of execution$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$property.city$tpl$, NULL, $tpl$[]$tpl$::jsonb, 1),
  ((SELECT id FROM document_templates WHERE template_key = 'builder_buyer_agreement'), 'execution_date', $tpl$Date of execution$tpl$, 'date', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 2),
  ((SELECT id FROM document_templates WHERE template_key = 'builder_buyer_agreement'), 'builder_name', $tpl$Builder / promoter$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$deal.seller_name$tpl$, NULL, $tpl$[]$tpl$::jsonb, 3),
  ((SELECT id FROM document_templates WHERE template_key = 'builder_buyer_agreement'), 'builder_address', $tpl$Builder registered office$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 4),
  ((SELECT id FROM document_templates WHERE template_key = 'builder_buyer_agreement'), 'buyer_name', $tpl$Buyer name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$deal.buyer_name$tpl$, NULL, $tpl$[]$tpl$::jsonb, 5),
  ((SELECT id FROM document_templates WHERE template_key = 'builder_buyer_agreement'), 'buyer_parent_name', $tpl$Buyer: son / daughter / wife of$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 6),
  ((SELECT id FROM document_templates WHERE template_key = 'builder_buyer_agreement'), 'buyer_address', $tpl$Buyer address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 7),
  ((SELECT id FROM document_templates WHERE template_key = 'builder_buyer_agreement'), 'project_name', $tpl$Project name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$property.description$tpl$, NULL, $tpl$[]$tpl$::jsonb, 8),
  ((SELECT id FROM document_templates WHERE template_key = 'builder_buyer_agreement'), 'property_address', $tpl$Project address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$property.address$tpl$, NULL, $tpl$[]$tpl$::jsonb, 9),
  ((SELECT id FROM document_templates WHERE template_key = 'builder_buyer_agreement'), 'rera_number', $tpl$RERA registration number$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$property.rera_number$tpl$, NULL, $tpl$[]$tpl$::jsonb, 10),
  ((SELECT id FROM document_templates WHERE template_key = 'builder_buyer_agreement'), 'unit_number', $tpl$Unit number$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 11),
  ((SELECT id FROM document_templates WHERE template_key = 'builder_buyer_agreement'), 'floor_number', $tpl$Floor$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 12),
  ((SELECT id FROM document_templates WHERE template_key = 'builder_buyer_agreement'), 'carpet_area_sqft', $tpl$Carpet area (sq ft)$tpl$, 'number', $tpl$[]$tpl$::jsonb, $tpl${"min": 1}$tpl$::jsonb, true, NULL, $tpl$property.area_sqft$tpl$, NULL, $tpl$[]$tpl$::jsonb, 13),
  ((SELECT id FROM document_templates WHERE template_key = 'builder_buyer_agreement'), 'parking_spaces', $tpl$Parking spaces$tpl$, 'number', $tpl$[]$tpl$::jsonb, $tpl${"max": 10, "min": 0}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 14),
  ((SELECT id FROM document_templates WHERE template_key = 'builder_buyer_agreement'), 'sale_consideration', $tpl$Total price$tpl$, 'currency', $tpl$[]$tpl$::jsonb, $tpl${"min": 1}$tpl$::jsonb, true, NULL, $tpl$deal.value$tpl$, NULL, $tpl$[]$tpl$::jsonb, 15),
  ((SELECT id FROM document_templates WHERE template_key = 'builder_buyer_agreement'), 'sale_consideration_words', $tpl$sale consideration in words$tpl$, 'computed', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, $tpl${"of": "sale_consideration", "kind": "amount_in_words"}$tpl$::jsonb, $tpl$[]$tpl$::jsonb, 16),
  ((SELECT id FROM document_templates WHERE template_key = 'builder_buyer_agreement'), 'payment_schedule', $tpl$Payment schedule$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 17),
  ((SELECT id FROM document_templates WHERE template_key = 'builder_buyer_agreement'), 'token_amount', $tpl$Booking amount$tpl$, 'currency', $tpl$[]$tpl$::jsonb, $tpl${"min": 1}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 18),
  ((SELECT id FROM document_templates WHERE template_key = 'builder_buyer_agreement'), 'token_amount_words', $tpl$token amount in words$tpl$, 'computed', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, $tpl${"of": "token_amount", "kind": "amount_in_words"}$tpl$::jsonb, $tpl$[]$tpl$::jsonb, 19),
  ((SELECT id FROM document_templates WHERE template_key = 'builder_buyer_agreement'), 'possession_date', $tpl$Possession on or before$tpl$, 'date', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 20),
  ((SELECT id FROM document_templates WHERE template_key = 'builder_buyer_agreement'), 'stamp_duty_amount', $tpl$Stamp duty (from the state rules)$tpl$, 'computed', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, $tpl${"of": "sale_consideration", "kind": "stamp_duty"}$tpl$::jsonb, $tpl$[]$tpl$::jsonb, 21),
  ((SELECT id FROM document_templates WHERE template_key = 'builder_buyer_agreement'), 'registration_fee_amount', $tpl$Registration fee (from the state rules)$tpl$, 'computed', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, $tpl${"of": "sale_consideration", "kind": "registration_fee"}$tpl$::jsonb, $tpl$[]$tpl$::jsonb, 22),
  ((SELECT id FROM document_templates WHERE template_key = 'builder_buyer_agreement'), 'witness_1_name', $tpl$Witness 1 name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 23),
  ((SELECT id FROM document_templates WHERE template_key = 'builder_buyer_agreement'), 'witness_2_name', $tpl$Witness 2 name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 24)
ON CONFLICT (template_id, name) DO NOTHING;

INSERT INTO document_templates (template_key, name, category, description, audience, duty_transaction, status, current_version, sort_order) VALUES ('nda_institutional', $tpl$NDA (Institutional)$tpl$, 'institutional', $tpl$Confidentiality undertaking before institutional information is disclosed.$tpl$, 'staff', 'sale', 'active', 1, 12) ON CONFLICT (template_key) DO NOTHING;
INSERT INTO document_template_versions (template_id, version, body, state_blocks, change_note) VALUES ((SELECT id FROM document_templates WHERE template_key = 'nda_institutional'), 1, $tpl$# Non-Disclosure Agreement

This Non-Disclosure Agreement is made at {{execution_place}} on this {{execution_date}}

## Between

{{disclosing_party_name}} (the "Disclosing Party")

## And

{{receiving_party_name}}, having address at {{receiving_party_address}} (the "Receiving Party").

## 1. Purpose

The Receiving Party wishes to evaluate a possible transaction concerning {{asset_description}} (the "Purpose") and the Disclosing Party will share confidential information for that Purpose only.

## 2. Confidential information

Confidential information means the identity of the institution, its financial statements, enrolment or occupancy data, approvals, and all other non-public information shared in any form.

## 3. Obligations

The Receiving Party shall keep the confidential information secret, use it only for the Purpose, share it only with its advisers who are bound by like obligations, and not approach the institution, its promoters, staff or lenders except through A R Buildwel.

## 4. Term

These obligations continue for {{confidentiality_period}} from the date of this Agreement, whether or not a transaction is concluded.

## 5. Return

On request the Receiving Party shall return or destroy all confidential information.

## 6. Remedies

The Receiving Party agrees that damages may not be a sufficient remedy for a breach and that the Disclosing Party is entitled to injunctive relief.

## 7. Governing law

This Agreement is governed by the laws of India and the courts at {{jurisdiction_city}} have jurisdiction.

Signed by the Receiving Party: {{receiving_party_signatory}}$tpl$, $tpl$[]$tpl$::jsonb, 'Launch library') ON CONFLICT (template_id, version) DO NOTHING;
INSERT INTO template_variables (template_id, name, label, field_type, options, validation, is_required, help_text, prefill, computed, state_codes, sort_order) VALUES
  ((SELECT id FROM document_templates WHERE template_key = 'nda_institutional'), 'execution_place', $tpl$Place of execution$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$property.city$tpl$, NULL, $tpl$[]$tpl$::jsonb, 1),
  ((SELECT id FROM document_templates WHERE template_key = 'nda_institutional'), 'execution_date', $tpl$Date of execution$tpl$, 'date', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 2),
  ((SELECT id FROM document_templates WHERE template_key = 'nda_institutional'), 'disclosing_party_name', $tpl$Disclosing party$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, $tpl$The institution, or "A R Buildwel on behalf of the institution"$tpl$, NULL, NULL, $tpl$[]$tpl$::jsonb, 3),
  ((SELECT id FROM document_templates WHERE template_key = 'nda_institutional'), 'receiving_party_name', $tpl$Receiving party (buyer)$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$deal.buyer_name$tpl$, NULL, $tpl$[]$tpl$::jsonb, 4),
  ((SELECT id FROM document_templates WHERE template_key = 'nda_institutional'), 'receiving_party_address', $tpl$Receiving party address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 5),
  ((SELECT id FROM document_templates WHERE template_key = 'nda_institutional'), 'asset_description', $tpl$Asset, described without naming it$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, $tpl$e.g. a K-12 school in West Delhi$tpl$, NULL, NULL, $tpl$[]$tpl$::jsonb, 6),
  ((SELECT id FROM document_templates WHERE template_key = 'nda_institutional'), 'confidentiality_period', $tpl$Confidentiality period$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, $tpl$e.g. three years$tpl$, NULL, NULL, $tpl$[]$tpl$::jsonb, 7),
  ((SELECT id FROM document_templates WHERE template_key = 'nda_institutional'), 'jurisdiction_city', $tpl$Jurisdiction (city)$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 8),
  ((SELECT id FROM document_templates WHERE template_key = 'nda_institutional'), 'receiving_party_signatory', $tpl$Authorised signatory of the receiving party$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 9)
ON CONFLICT (template_id, name) DO NOTHING;

INSERT INTO document_templates (template_key, name, category, description, audience, duty_transaction, status, current_version, sort_order) VALUES ('mandate_letter', $tpl$Mandate Letter (Exclusive and Standard)$tpl$, 'mandate', $tpl$Letter appointing A R Buildwel to facilitate a sale or purchase, exclusive or standard.$tpl$, 'staff', 'sale', 'active', 1, 13) ON CONFLICT (template_key) DO NOTHING;
INSERT INTO document_template_versions (template_id, version, body, state_blocks, change_note) VALUES ((SELECT id FROM document_templates WHERE template_key = 'mandate_letter'), 1, $tpl$# Mandate Letter

Date: {{execution_date}}

To: A R Buildwel (the PropertySerch platform)

## 1. Appointment

I/We, {{client_name}}, residing at {{client_address}} (the "Client"), appoint A R Buildwel on a {{mandate_type}} basis to facilitate the {{mandate_purpose}} of the property described as {{property_description}} situated at {{property_address}}.

## 2. Period

This mandate is valid for {{mandate_period}} from {{mandate_start_date}}.

## 3. Exclusivity

Where this is an Exclusive mandate, the Client shall not appoint any other intermediary or deal directly with any party for the above purpose during the mandate period, and every enquiry received by the Client shall be referred to A R Buildwel.

## 4. Professional fee

The Client shall pay A R Buildwel a professional fee of {{fee_percent}} percent of the gross transaction value plus applicable GST, payable in two instalments: fifty percent on execution of the Agreement to Sell and fifty percent on execution of the Sale Deed.

## 5. Price

The Client's indicative expectation is recorded separately with A R Buildwel in confidence and is not disclosed to any other party.

## 6. Role of A R Buildwel

A R Buildwel acts as a facilitator. It does not give legal, tax or financial advice. The Client shall engage an advocate of the Client's own choice for legal review, stamping and registration.

## 7. Authority

The Client confirms that the Client is entitled to deal with the property and that the information given is true.

Signed by the Client: {{client_name}}

Accepted for A R Buildwel: {{representative_name}}$tpl$, $tpl$[]$tpl$::jsonb, 'Launch library') ON CONFLICT (template_id, version) DO NOTHING;
INSERT INTO template_variables (template_id, name, label, field_type, options, validation, is_required, help_text, prefill, computed, state_codes, sort_order) VALUES
  ((SELECT id FROM document_templates WHERE template_key = 'mandate_letter'), 'execution_date', $tpl$Date$tpl$, 'date', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 1),
  ((SELECT id FROM document_templates WHERE template_key = 'mandate_letter'), 'client_name', $tpl$Client name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$deal.seller_name$tpl$, NULL, $tpl$[]$tpl$::jsonb, 2),
  ((SELECT id FROM document_templates WHERE template_key = 'mandate_letter'), 'client_address', $tpl$Client address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 3),
  ((SELECT id FROM document_templates WHERE template_key = 'mandate_letter'), 'mandate_type', $tpl$Mandate type$tpl$, 'dropdown', $tpl$["Exclusive", "Standard"]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 4),
  ((SELECT id FROM document_templates WHERE template_key = 'mandate_letter'), 'mandate_purpose', $tpl$Purpose$tpl$, 'dropdown', $tpl$["sale", "purchase", "lease"]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 5),
  ((SELECT id FROM document_templates WHERE template_key = 'mandate_letter'), 'property_description', $tpl$Property description$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$property.description$tpl$, NULL, $tpl$[]$tpl$::jsonb, 6),
  ((SELECT id FROM document_templates WHERE template_key = 'mandate_letter'), 'property_address', $tpl$Property address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$property.address$tpl$, NULL, $tpl$[]$tpl$::jsonb, 7),
  ((SELECT id FROM document_templates WHERE template_key = 'mandate_letter'), 'mandate_period', $tpl$Mandate period$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, $tpl$e.g. six months$tpl$, NULL, NULL, $tpl$[]$tpl$::jsonb, 8),
  ((SELECT id FROM document_templates WHERE template_key = 'mandate_letter'), 'mandate_start_date', $tpl$Mandate start date$tpl$, 'date', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 9),
  ((SELECT id FROM document_templates WHERE template_key = 'mandate_letter'), 'fee_percent', $tpl$Professional fee (%)$tpl$, 'number', $tpl$[]$tpl$::jsonb, $tpl${"max": 10, "min": 0}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 10),
  ((SELECT id FROM document_templates WHERE template_key = 'mandate_letter'), 'representative_name', $tpl$A R Buildwel representative$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$deal.representative$tpl$, NULL, $tpl$[]$tpl$::jsonb, 11)
ON CONFLICT (template_id, name) DO NOTHING;

INSERT INTO document_templates (template_key, name, category, description, audience, duty_transaction, status, current_version, sort_order) VALUES ('exchange_deed', $tpl$Exchange Deed (linked-leg)$tpl$, 'exchange', $tpl$Deed of exchange of two properties, with the value difference recorded.$tpl$, 'staff', 'sale', 'active', 1, 14) ON CONFLICT (template_key) DO NOTHING;
INSERT INTO document_template_versions (template_id, version, body, state_blocks, change_note) VALUES ((SELECT id FROM document_templates WHERE template_key = 'exchange_deed'), 1, $tpl$# Deed of Exchange

This Deed of Exchange is made at {{execution_place}} on this {{execution_date}}

## Between

{{first_party_name}}, residing at {{first_party_address}} (the "First Party")

## And

{{second_party_name}}, residing at {{second_party_address}} (the "Second Party").

## First Property

The property owned by the First Party situated at {{first_property_address}}, valued by the parties at {{first_property_value}} ({{first_property_value_words}}).

## Second Property

The property owned by the Second Party situated at {{second_property_address}}, valued by the parties at {{second_property_value}} ({{second_property_value_words}}).

{{state_clauses}}

## 1. Exchange

The First Party transfers the First Property to the Second Party, and in exchange the Second Party transfers the Second Property to the First Party, each absolutely and forever, with all rights and appurtenances.

## 2. Equalisation

To equalise the values, {{difference_payer}} has paid {{value_difference}} ({{value_difference_words}}) to the other party directly, the receipt of which is acknowledged. This payment is made between the parties and not through any intermediary.

## 3. Possession

Each party has this day delivered vacant possession of its property to the other.

## 4. Title

Each party declares that its property is free from encumbrances and litigation and shall indemnify the other against any defect in title.

## 5. Linked legs

The two transfers under this deed are linked: neither takes effect without the other.

## 6. Stamp duty

Stamp duty of {{stamp_duty_amount}}, indicative as per the rules of the State and computed on the higher of the two values, and registration charges shall be borne by the parties equally.

## Witnesses

IN WITNESS WHEREOF the parties have signed this document on the date first written above in the presence of the following witnesses.

Witness 1: {{witness_1_name}}

Witness 2: {{witness_2_name}}$tpl$, $tpl$[{"body": "## Karnataka particulars\n\nThe Scheduled Property bears Khata No. {{khata_number}} and Survey No. {{survey_number}} in the records of the jurisdictional authority.", "stateCode": "KA"}, {"body": "## Tamil Nadu particulars\n\nThe Scheduled Property is comprised in Patta No. {{patta_number}} and Survey No. {{survey_number}} in the revenue records.", "stateCode": "TN"}, {"body": "## Delhi particulars\n\nWhere the Scheduled Property lies within Lal Dora / extended Lal Dora, the certificate bearing No. {{lal_dora_certificate}} issued by the competent authority forms part of the title papers.", "stateCode": "DL"}]$tpl$::jsonb, 'Launch library') ON CONFLICT (template_id, version) DO NOTHING;
INSERT INTO template_variables (template_id, name, label, field_type, options, validation, is_required, help_text, prefill, computed, state_codes, sort_order) VALUES
  ((SELECT id FROM document_templates WHERE template_key = 'exchange_deed'), 'execution_place', $tpl$Place of execution$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$property.city$tpl$, NULL, $tpl$[]$tpl$::jsonb, 1),
  ((SELECT id FROM document_templates WHERE template_key = 'exchange_deed'), 'execution_date', $tpl$Date of execution$tpl$, 'date', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 2),
  ((SELECT id FROM document_templates WHERE template_key = 'exchange_deed'), 'first_party_name', $tpl$First party$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$deal.seller_name$tpl$, NULL, $tpl$[]$tpl$::jsonb, 3),
  ((SELECT id FROM document_templates WHERE template_key = 'exchange_deed'), 'first_party_address', $tpl$First party address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 4),
  ((SELECT id FROM document_templates WHERE template_key = 'exchange_deed'), 'second_party_name', $tpl$Second party$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$deal.buyer_name$tpl$, NULL, $tpl$[]$tpl$::jsonb, 5),
  ((SELECT id FROM document_templates WHERE template_key = 'exchange_deed'), 'second_party_address', $tpl$Second party address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 6),
  ((SELECT id FROM document_templates WHERE template_key = 'exchange_deed'), 'first_property_address', $tpl$First property address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, $tpl$property.address$tpl$, NULL, $tpl$[]$tpl$::jsonb, 7),
  ((SELECT id FROM document_templates WHERE template_key = 'exchange_deed'), 'first_property_value', $tpl$First property value$tpl$, 'currency', $tpl$[]$tpl$::jsonb, $tpl${"min": 1}$tpl$::jsonb, true, NULL, $tpl$deal.value$tpl$, NULL, $tpl$[]$tpl$::jsonb, 8),
  ((SELECT id FROM document_templates WHERE template_key = 'exchange_deed'), 'first_property_value_words', $tpl$first property value in words$tpl$, 'computed', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, $tpl${"of": "first_property_value", "kind": "amount_in_words"}$tpl$::jsonb, $tpl$[]$tpl$::jsonb, 9),
  ((SELECT id FROM document_templates WHERE template_key = 'exchange_deed'), 'second_property_address', $tpl$Second property address$tpl$, 'longtext', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 10),
  ((SELECT id FROM document_templates WHERE template_key = 'exchange_deed'), 'second_property_value', $tpl$Second property value$tpl$, 'currency', $tpl$[]$tpl$::jsonb, $tpl${"min": 1}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 11),
  ((SELECT id FROM document_templates WHERE template_key = 'exchange_deed'), 'second_property_value_words', $tpl$second property value in words$tpl$, 'computed', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, $tpl${"of": "second_property_value", "kind": "amount_in_words"}$tpl$::jsonb, $tpl$[]$tpl$::jsonb, 12),
  ((SELECT id FROM document_templates WHERE template_key = 'exchange_deed'), 'difference_payer', $tpl$Who pays the difference$tpl$, 'dropdown', $tpl$["the First Party", "the Second Party"]$tpl$::jsonb, $tpl${}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 13),
  ((SELECT id FROM document_templates WHERE template_key = 'exchange_deed'), 'value_difference', $tpl$Value difference paid$tpl$, 'currency', $tpl$[]$tpl$::jsonb, $tpl${"min": 0}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 14),
  ((SELECT id FROM document_templates WHERE template_key = 'exchange_deed'), 'value_difference_words', $tpl$value difference in words$tpl$, 'computed', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, $tpl${"of": "value_difference", "kind": "amount_in_words"}$tpl$::jsonb, $tpl$[]$tpl$::jsonb, 15),
  ((SELECT id FROM document_templates WHERE template_key = 'exchange_deed'), 'higher_value', $tpl$Higher of the two values (for stamp duty)$tpl$, 'currency', $tpl$[]$tpl$::jsonb, $tpl${"min": 1}$tpl$::jsonb, true, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 16),
  ((SELECT id FROM document_templates WHERE template_key = 'exchange_deed'), 'stamp_duty_amount', $tpl$Stamp duty (from the state rules)$tpl$, 'computed', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, $tpl${"of": "higher_value", "kind": "stamp_duty"}$tpl$::jsonb, $tpl$[]$tpl$::jsonb, 17),
  ((SELECT id FROM document_templates WHERE template_key = 'exchange_deed'), 'khata_number', $tpl$Khata number$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, $tpl$From the BBMP / panchayat khata certificate$tpl$, NULL, NULL, $tpl$["KA"]$tpl$::jsonb, 18),
  ((SELECT id FROM document_templates WHERE template_key = 'exchange_deed'), 'patta_number', $tpl$Patta number$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$["TN"]$tpl$::jsonb, 19),
  ((SELECT id FROM document_templates WHERE template_key = 'exchange_deed'), 'survey_number', $tpl$Survey number$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$["KA", "TN", "AP", "TS", "MH", "GJ"]$tpl$::jsonb, 20),
  ((SELECT id FROM document_templates WHERE template_key = 'exchange_deed'), 'lal_dora_certificate', $tpl$Lal Dora certificate number$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$["DL"]$tpl$::jsonb, 21),
  ((SELECT id FROM document_templates WHERE template_key = 'exchange_deed'), 'witness_1_name', $tpl$Witness 1 name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 22),
  ((SELECT id FROM document_templates WHERE template_key = 'exchange_deed'), 'witness_2_name', $tpl$Witness 2 name$tpl$, 'text', $tpl$[]$tpl$::jsonb, $tpl${}$tpl$::jsonb, false, NULL, NULL, NULL, $tpl$[]$tpl$::jsonb, 23)
ON CONFLICT (template_id, name) DO NOTHING;
