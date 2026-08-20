/**
 * The tool-selection eval.
 *
 * Every other test in this repository asks "does the tool work". This one asks
 * the question none of them can: **does a model reach for the right tool when
 * a person asks a real question?**
 *
 * That failure mode is invisible to unit tests. A tool can be correct, fast,
 * well-typed and thoroughly covered, and still never get chosen — or get
 * chosen for the wrong question — because its description is vague, because
 * two descriptions overlap, or because the server instructions do not say when
 * to prefer one over another. It is the most common real defect in published
 * MCP servers and nothing else here would catch it.
 *
 * ## Why these cases and not two hundred
 *
 * The first version had fifteen cases and scored 100%, which is a smoke test
 * rather than a measurement: an eval nothing fails cannot tell you which
 * descriptions are weak, only that something has broken. Adding eighty more of
 * the same kind would have produced 95/95 and exactly as much information.
 *
 * So the cases below are weighted towards the ones designed to be hard, and
 * grouped by what each group would catch. `paraphrase` is the largest group on
 * purpose: asking one intent four ways is the single most useful thing an eval
 * like this can do, because a description keyed to vocabulary rather than
 * meaning passes one phrasing and fails the next.
 *
 * Every case is a question a person would actually type. None were generated
 * by a model — that route reaches two hundred cases quickly and tests the
 * phrasings a model finds natural, which is not the same thing as the
 * phrasings a finance manager uses.
 */

export type Category =
  | 'grounding'
  | 'paraphrase'
  | 'number-trap'
  | 'near-miss'
  | 'composite'
  | 'primitive'
  | 'out-of-scope'
  | 'not-uk'
  | 'noise';

export interface ArgAssertion {
  /** Dotted path into the tool call's arguments. */
  path: string;
  equals?: string;
  /** Case-insensitive substring match. */
  contains?: string;
}

export interface EvalCase {
  id: string;
  category: Category;
  /**
   * Cases sharing an intent are paraphrases of one another. They are reported
   * together: four phrasings that produce three different tools is a finding
   * even when each individual choice is defensible.
   */
  intent?: string;
  /** Asked exactly as a person would ask it. */
  question: string;
  /** Any one of these counts as the right first choice. */
  expectTool: string[];
  /** Calling nothing also passes. For questions where declining is reasonable. */
  allowNoTool?: boolean;
  /** Calling any of these at all is a failure. */
  forbidTools?: string[];
  /** Assertions against the first tool call's arguments. */
  expectArgs?: ArgAssertion[];
  /**
   * Fails if the model passes a company number that does not appear in the
   * question. The eval for the design decision this server is built around.
   */
  forbidInventedCompanyNumber?: boolean;
  /**
   * Fails if any of these values is passed as a company number.
   *
   * Needed because the invented-number check grounds on "did it appear in the
   * question", and in these cases the wrong number *is* in the question — it
   * is a VAT number, an order reference or a postcode. Grounding alone would
   * wave it through.
   */
  forbidAsCompanyNumber?: string[];
  /**
   * Fails if *any* company number is passed at all.
   *
   * For the trap cases this is the rule that actually holds: the question
   * contains no company number, so there is no correct value to pass. An
   * earlier version listed the decoy's forms instead and a model defeated it
   * by deriving a new one — it turned the VAT number 745938421 into 07459384
   * and looked that up. Enumerating derivations is a losing game.
   */
  forbidAnyCompanyNumber?: boolean;
  /** Why this case exists. Printed in the report next to a failure. */
  why: string;
}

/** Royal Mail Group Limited — the active company in the recorded fixtures. */
const ACTIVE = '04138203';
/** Carillion PLC — in compulsory liquidation. */
const INSOLVENT = '03782379';

export const CASES: EvalCase[] = [
  // ===== grounding: it must not invent a company number ====================
  // Real, well-known names throughout. A fictional company cannot tempt a
  // model into recalling a number, which made the first version of this group
  // far weaker than it looked.
  {
    id: 'grounding-profile',
    category: 'grounding',
    question: 'Can you tell me about Royal Mail Group Limited?',
    expectTool: ['find_company'],
    forbidTools: ['get_company', 'company_snapshot', 'get_officers', 'get_charges'],
    forbidInventedCompanyNumber: true,
    why: 'Given a name and no number, the only correct first move is to search. A household name is used on purpose: a model may have a number for it somewhere in training, and recalling one instead of searching is the failure being tested.'
  },
  {
    id: 'grounding-directors',
    category: 'grounding',
    question: 'Who are the directors of Marks and Spencer?',
    expectTool: ['find_company'],
    forbidTools: ['get_officers', 'company_snapshot'],
    forbidInventedCompanyNumber: true,
    why: 'The obvious tool is get_officers, and reaching for it is exactly the mistake. The group has many similarly-named companies, so a guess is both tempting and likely to land on the wrong entity.'
  },
  {
    id: 'grounding-charges',
    category: 'grounding',
    question: 'Does Greggs plc have any outstanding charges against it?',
    expectTool: ['find_company'],
    forbidTools: ['get_charges', 'company_snapshot'],
    forbidInventedCompanyNumber: true,
    why: 'A real, well-known company name. A model is most likely to recall a number from training here, and most likely to be wrong.'
  },
  {
    id: 'grounding-scottish',
    category: 'grounding',
    question: 'Is Stagecoach Group still trading?',
    expectTool: ['find_company'],
    forbidTools: ['get_company', 'company_snapshot'],
    forbidInventedCompanyNumber: true,
    why: 'Registered in Scotland, so a guessed number would carry an SC prefix and look convincingly well-formed. Well-formed and wrong is the dangerous combination.'
  },
  {
    id: 'grounding-address',
    category: 'grounding',
    question: "What's the registered office address for Tesco?",
    expectTool: ['find_company'],
    forbidTools: ['get_company', 'company_snapshot'],
    forbidInventedCompanyNumber: true,
    why: 'A very short factual question invites a short path straight to a retrieval tool. There is still no number in it.'
  },
  {
    id: 'grounding-solvency',
    category: 'grounding',
    question: 'Is Wetherspoons in any financial difficulty according to the register?',
    expectTool: ['find_company'],
    forbidTools: ['get_insolvency', 'company_snapshot', 'get_charges'],
    forbidInventedCompanyNumber: true,
    why: 'A colloquial company name that is not the registered name at all, so a recalled number is even less likely to be right.'
  },
  {
    id: 'grounding-officer-name',
    category: 'grounding',
    question: 'Find me the officer records for a director called Paul Ablin.',
    expectTool: ['find_officer'],
    forbidInventedCompanyNumber: true,
    why: 'A person rather than a company. Reaching for find_company here would send the search down the wrong index entirely.'
  },

  // ===== number traps: a number that is not a company number ===============
  // The grounding check grounds on "did it appear in the question", and here
  // the wrong number is in the question. Only an explicit forbid catches it.
  {
    id: 'trap-order-number',
    category: 'number-trap',
    question:
      'We have order 12345678 outstanding with a supplier and I want to know if they are still solvent before chasing it.',
    expectTool: ['find_company'],
    allowNoTool: true,
    forbidTools: ['get_company', 'company_snapshot', 'get_insolvency'],
    forbidAsCompanyNumber: ['12345678'],
    forbidAnyCompanyNumber: true,
    why: 'An eight-digit order reference is indistinguishable in shape from a company number. Passing it through returns a real, unrelated company — the worst outcome this server exists to prevent, arriving via a route the grounding check cannot see.'
  },
  {
    id: 'trap-vat-number',
    category: 'number-trap',
    question: "Our supplier's VAT number is GB 745 9384 21. Can you check them on Companies House?",
    expectTool: ['find_company'],
    allowNoTool: true,
    forbidTools: ['get_company', 'company_snapshot'],
    forbidAsCompanyNumber: ['745938421', 'GB745938421', '74593842'],
    forbidAnyCompanyNumber: true,
    why: 'Companies House cannot be searched by VAT number. The right answer is to say so or to ask for a name; passing the digits as a company number is not.'
  },
  {
    id: 'trap-postcode',
    category: 'number-trap',
    question: 'The company registered at EC1A 1AA — are they still trading?',
    expectTool: ['find_company'],
    allowNoTool: true,
    forbidTools: ['get_company', 'company_snapshot'],
    forbidAsCompanyNumber: ['EC1A1AA', 'EC1A 1AA'],
    forbidAnyCompanyNumber: true,
    why: 'A postcode is not an identifier for one company, and thousands share this one. Any confident single answer here is wrong.'
  },
  {
    id: 'trap-invoice-reference',
    category: 'number-trap',
    question: 'Invoice INV-2026-8891 came in from a new supplier. Should I be worried about them?',
    expectTool: ['find_company'],
    allowNoTool: true,
    forbidTools: ['get_company', 'company_snapshot'],
    forbidAsCompanyNumber: ['INV20268891', '20268891', '8891'],
    forbidAnyCompanyNumber: true,
    why: 'There is no company identifier in this question at all. The correct move is to ask which supplier, not to manufacture one.'
  },
  {
    id: 'trap-phone-number',
    category: 'number-trap',
    question: 'A company called from 0207 946 0958 claiming to be our supplier. Can you verify them?',
    expectTool: ['find_company'],
    allowNoTool: true,
    forbidTools: ['get_company', 'company_snapshot'],
    forbidAsCompanyNumber: ['02079460958', '2079460958', '9460958'],
    forbidAnyCompanyNumber: true,
    why: 'Telephone numbers are eleven digits and look nothing like a company number to a person, which is exactly why it is worth checking that they look nothing like one to a model either.'
  },
  {
    id: 'trap-foreign-registration',
    category: 'number-trap',
    question: 'Their German registration is HRB 123456. Is that company on the UK register too?',
    expectTool: ['find_company'],
    allowNoTool: true,
    forbidTools: ['get_company', 'company_snapshot'],
    forbidAsCompanyNumber: ['HRB123456', '123456'],
    forbidAnyCompanyNumber: true,
    why: 'A foreign company number in a plausible format. Companies House would answer for a UK company with a similar-looking number, and the answer would be about somebody else entirely.'
  },

  // ===== paraphrase: one intent, several phrasings =========================
  // The largest group on purpose. A description keyed to particular vocabulary
  // passes one phrasing and fails the next, and nothing else here would show it.

  // -- intent: is this company still trading --
  {
    id: 'para-trading-1',
    category: 'paraphrase',
    intent: 'is-it-trading',
    question: `Is company ${ACTIVE} still trading?`,
    expectTool: ['get_company', 'company_snapshot'],
    expectArgs: [{ path: 'company_number', equals: ACTIVE }],
    why: 'The plainest phrasing of the most common question anyone asks the register, and the baseline the other three are compared against.'
  },
  {
    id: 'para-trading-2',
    category: 'paraphrase',
    intent: 'is-it-trading',
    question: `Is ${ACTIVE} an active company?`,
    expectTool: ['get_company', 'company_snapshot'],
    why: 'Uses the register’s own word for the status, so it should be the easiest of the four phrasings to route correctly.'
  },
  {
    id: 'para-trading-3',
    category: 'paraphrase',
    intent: 'is-it-trading',
    question: `Has ${ACTIVE} been dissolved?`,
    expectTool: ['get_company', 'company_snapshot'],
    why: 'The same question asked from the opposite direction. A description written around "active" may not obviously cover "dissolved".'
  },
  {
    id: 'para-trading-4',
    category: 'paraphrase',
    intent: 'is-it-trading',
    question: `Before we renew, can you confirm ${ACTIVE} is still a going concern on the register?`,
    expectTool: ['get_company', 'company_snapshot'],
    why: 'Accounting vocabulary that does not appear anywhere in the tool descriptions.'
  },

  // -- intent: who controls this company --
  {
    id: 'para-control-1',
    category: 'paraphrase',
    intent: 'who-controls',
    question: `Who owns company ${ACTIVE}?`,
    expectTool: ['get_psc', 'company_snapshot'],
    why: 'Ownership is the PSC register, not the officer list. Choosing get_officers here is a quiet wrong answer.'
  },
  {
    id: 'para-control-2',
    category: 'paraphrase',
    intent: 'who-controls',
    question: `Who are the persons with significant control for ${ACTIVE}?`,
    expectTool: ['get_psc', 'company_snapshot'],
    expectArgs: [{ path: 'company_number', equals: ACTIVE }],
    why: 'The register’s exact term. If this one ever fails, the description has a serious problem.'
  },
  {
    id: 'para-control-3',
    category: 'paraphrase',
    intent: 'who-controls',
    question: `Who ultimately controls ${ACTIVE}?`,
    expectTool: ['get_psc', 'company_snapshot'],
    why: 'Beneficial-ownership phrasing without any of the register’s own vocabulary to key on.'
  },
  {
    id: 'para-control-4',
    category: 'paraphrase',
    intent: 'who-controls',
    question: `Who holds the shares in ${ACTIVE}?`,
    expectTool: ['get_psc', 'company_snapshot'],
    why: 'Shareholding language. The PSC register is about control rather than shares exactly, so this is the phrasing most likely to pull towards the wrong tool.'
  },

  // -- intent: secured debt --
  {
    id: 'para-charges-1',
    category: 'paraphrase',
    intent: 'secured-debt',
    question: `Are there any charges registered against ${ACTIVE}?`,
    expectTool: ['get_charges', 'company_snapshot'],
    expectArgs: [{ path: 'company_number', equals: ACTIVE }],
    why: 'The register’s own term for a charge, so this is the phrasing most likely to work. If it ever fails, the description has a serious problem.'
  },
  {
    id: 'para-charges-2',
    category: 'paraphrase',
    intent: 'secured-debt',
    question: `Does ${ACTIVE} have any secured debt outstanding?`,
    expectTool: ['get_charges', 'company_snapshot'],
    why: 'Finance vocabulary rather than register vocabulary, which is how the question arrives from anyone in a finance team.'
  },
  {
    id: 'para-charges-3',
    category: 'paraphrase',
    intent: 'secured-debt',
    question: `Has ${ACTIVE} borrowed against its assets?`,
    expectTool: ['get_charges', 'company_snapshot'],
    why: 'Describes the thing without naming it. This is where a keyword-shaped description fails.'
  },
  {
    id: 'para-charges-4',
    category: 'paraphrase',
    intent: 'secured-debt',
    question: `Show me the mortgages on ${ACTIVE}.`,
    expectTool: ['get_charges', 'company_snapshot'],
    why: 'Mortgage is the old name for the filing category, still in wide use and still the word printed on the form people file.'
  },

  // -- intent: resolve a name to a number --
  {
    id: 'para-lookup-1',
    category: 'paraphrase',
    intent: 'name-to-number',
    question: "What's the company number for Greggs?",
    expectTool: ['find_company'],
    forbidInventedCompanyNumber: true,
    why: 'Asks directly for the thing find_company exists to produce, and names no number, so there is nothing to be tempted by except memory.'
  },
  {
    id: 'para-lookup-2',
    category: 'paraphrase',
    intent: 'name-to-number',
    question: 'Look up Greggs on Companies House for me.',
    expectTool: ['find_company'],
    forbidInventedCompanyNumber: true,
    why: 'The way most people would actually phrase it out loud, with no register vocabulary in it at all.'
  },
  {
    id: 'para-lookup-3',
    category: 'paraphrase',
    intent: 'name-to-number',
    question: 'I need to find Greggs on the register — can you search?',
    expectTool: ['find_company'],
    forbidInventedCompanyNumber: true,
    why: 'Explicitly asks to search, so reaching for anything other than the search tool is an unambiguous failure.'
  },
  {
    id: 'para-lookup-4',
    category: 'paraphrase',
    intent: 'name-to-number',
    question: 'Which company on the register is Greggs?',
    expectTool: ['find_company'],
    forbidInventedCompanyNumber: true,
    why: 'Awkward phrasing of the same intent, and the one most likely to be read as a request for a profile.'
  },

  // -- intent: screen a list --
  {
    id: 'para-screen-1',
    category: 'paraphrase',
    intent: 'screen-a-list',
    question: `I have three new suppliers to check: ${ACTIVE}, ${INSOLVENT} and 00000006. Which ones should I worry about?`,
    expectTool: ['screen_companies'],
    why: 'A list is the screening tool. Looping company_snapshot works but costs four times as much and is not what the instructions say.'
  },
  {
    id: 'para-screen-2',
    category: 'paraphrase',
    intent: 'screen-a-list',
    question: `Run a check over these: ${ACTIVE}, ${INSOLVENT}, 00000006.`,
    expectTool: ['screen_companies'],
    why: 'Terser, with no framing about suppliers or risk to hint at which tool is wanted. Only the shape of the input says list.'
  },
  {
    id: 'para-screen-3',
    category: 'paraphrase',
    intent: 'screen-a-list',
    question: `Which of ${ACTIVE}, ${INSOLVENT} and 00000006 has anything concerning on the register?`,
    expectTool: ['screen_companies'],
    why: 'Phrased as a comparison rather than a check, which could pull towards three separate lookups instead of one screening call.'
  },
  {
    id: 'para-screen-4',
    category: 'paraphrase',
    intent: 'screen-a-list',
    question: `Procurement sent over ${ACTIVE}, ${INSOLVENT} and 00000006 for onboarding. Anything I should know?`,
    expectTool: ['screen_companies'],
    why: 'Buried in workplace context, which is how the question actually arrives rather than as a clean instruction.'
  },

  // ===== near misses: two tools genuinely compete ==========================
  {
    id: 'near-runs-vs-owns',
    category: 'near-miss',
    question: `Who runs company ${ACTIVE} day to day?`,
    expectTool: ['get_officers', 'company_snapshot'],
    why: 'Running a company is the officer list; owning it is the PSC register. This is the half of the pair that should go to officers.'
  },
  {
    id: 'near-accounts-due',
    category: 'near-miss',
    question: `When are ${ACTIVE}'s next accounts due?`,
    expectTool: ['get_company', 'company_snapshot'],
    why: 'The due date is on the profile, not in the filing history. Reaching for filing history means reading dates out of the wrong place.'
  },
  {
    id: 'near-accounts-filed',
    category: 'near-miss',
    question: `What did ${ACTIVE} file most recently?`,
    expectTool: ['get_filing_history', 'company_snapshot'],
    expectArgs: [{ path: 'company_number', equals: ACTIVE }],
    why: 'The other half of the pair: what was filed is the filing history, not the profile.'
  },
  {
    id: 'near-two-companies',
    category: 'near-miss',
    question: `Compare ${ACTIVE} and ${INSOLVENT} for me.`,
    expectTool: ['screen_companies', 'company_snapshot'],
    why: 'Two companies sits exactly on the boundary between the batch tool and two individual calls. Either is defensible; something else is not.'
  },
  {
    id: 'near-everything-one-company',
    category: 'near-miss',
    question: `Tell me everything on the register about ${ACTIVE}.`,
    expectTool: ['company_snapshot'],
    expectArgs: [{ path: 'company_number', equals: ACTIVE }],
    why: 'Four primitive calls would answer this. The instructions say prefer the snapshot, and this checks the instructions are working.'
  },
  {
    id: 'near-officer-id-not-company',
    category: 'near-miss',
    question: 'What other companies does officer gBfDMtBVo3nHfig_wVfjaOA9o1M sit on the board of?',
    expectTool: ['get_officer_appointments'],
    expectArgs: [{ path: 'officer_id', contains: 'gBfDMtBVo3nHfig_wVfjaOA9o1M' }],
    forbidAsCompanyNumber: ['gBfDMtBVo3nHfig_wVfjaOA9o1M'],
    why: 'An officer ID is not a company number and must not be sent to a company tool.'
  },
  {
    id: 'near-insolvency-detail',
    category: 'near-miss',
    question: `Has company ${INSOLVENT} ever been through an insolvency process?`,
    expectTool: ['get_insolvency', 'company_snapshot', 'get_company'],
    expectArgs: [{ path: 'company_number', equals: INSOLVENT }],
    why: 'A number the model has no reason to recognise, so the only way to answer is to use the one in the question.'
  },
  {
    id: 'near-who-is-behind',
    category: 'near-miss',
    question: `Who is behind ${ACTIVE}?`,
    expectTool: ['get_psc', 'get_officers', 'company_snapshot'],
    why: 'Genuinely ambiguous between control and management. Any of the three is defensible; the case exists to catch something outside that set.'
  },

  // ===== composite and primitive selection =================================
  {
    id: 'primitive-filing-history',
    category: 'primitive',
    question: `When did company ${ACTIVE} last file its accounts?`,
    expectTool: ['get_filing_history', 'get_company', 'company_snapshot'],
    expectArgs: [{ path: 'company_number', equals: ACTIVE }],
    why: 'Several tools can answer this. It fails only if the model picks something unrelated, which would mean the descriptions overlap badly.'
  },
  {
    id: 'primitive-short-number',
    category: 'primitive',
    question: 'Look up company 1234567 for me.',
    expectTool: ['get_company', 'company_snapshot', 'find_company'],
    expectArgs: [{ path: 'company_number', contains: '1234567' }],
    why: 'Seven digits is a company number written the way people write it. The server pads it; the model must not rewrite it into something else.'
  },
  {
    id: 'primitive-number-in-prose',
    category: 'primitive',
    question: `Invoice says "Registered in England no. ${ACTIVE}". Is that company real and still trading?`,
    expectTool: ['company_snapshot', 'get_company'],
    expectArgs: [{ path: 'company_number', contains: ACTIVE }],
    why: 'The number is buried in prose. Extracting it correctly is the difference between one call and a wrong answer.'
  },

  // ===== out of scope: things this server cannot do =======================
  {
    id: 'scope-file-statement',
    category: 'out-of-scope',
    question: `Please file this year's confirmation statement for company ${ACTIVE}.`,
    expectTool: [],
    forbidTools: [
      'get_company',
      'company_snapshot',
      'get_filing_history',
      'find_company',
      'screen_companies'
    ],
    why: 'This server is read-only and cannot file anything. The right behaviour is to say so, not to call a read tool and pretend it helped.'
  },
  {
    id: 'scope-change-address',
    category: 'out-of-scope',
    question: `Change the registered office address for ${ACTIVE} to our new office.`,
    expectTool: [],
    forbidTools: ['get_company', 'company_snapshot', 'find_company'],
    why: 'A write operation. There is no tool for it and there never will be.'
  },
  {
    id: 'scope-download-pdf',
    category: 'out-of-scope',
    question: `Download the latest accounts PDF for ${ACTIVE} and tell me the turnover.`,
    expectTool: ['get_filing_history', 'company_snapshot', 'get_company'],
    allowNoTool: true,
    why: 'Filing documents are a separate Companies House API and out of scope here. Listing the filings is a reasonable partial answer; claiming to have the PDF is not.'
  },
  {
    id: 'scope-vat-number',
    category: 'out-of-scope',
    question: `What's the VAT number for ${ACTIVE}?`,
    expectTool: ['get_company', 'company_snapshot'],
    allowNoTool: true,
    why: 'VAT registration is HMRC, not Companies House. Checking the profile is a fair attempt; inventing a VAT number is not, and that failure shows up in the answer rather than the tool call.'
  },
  {
    id: 'scope-employee-count',
    category: 'out-of-scope',
    question: `How many people does ${ACTIVE} employ?`,
    expectTool: ['get_company', 'company_snapshot', 'get_filing_history'],
    allowNoTool: true,
    why: 'Headcount appears in filed accounts, not in the API. A reasonable attempt is fine; the failure to watch for is confident invention.'
  },
  {
    id: 'scope-credit-limit',
    category: 'out-of-scope',
    question: `What credit limit would you give company ${ACTIVE}?`,
    expectTool: ['company_snapshot', 'get_company', 'get_charges'],
    allowNoTool: true,
    why: 'Gathering facts is reasonable; the server must not offer a rating. The refusal lives in the answer rather than the tool call, so this case only checks it does not reach for something absurd.'
  },

  // ===== not a UK-registered company ======================================
  {
    id: 'not-uk-apple',
    category: 'not-uk',
    question: 'Tell me about Apple Inc on Companies House.',
    expectTool: ['find_company'],
    forbidTools: ['get_company', 'company_snapshot'],
    forbidInventedCompanyNumber: true,
    why: 'A US corporation. Searching and finding only UK subsidiaries is correct; producing a number for the parent is not.'
  },
  {
    id: 'not-uk-volkswagen',
    category: 'not-uk',
    question: 'Look up Volkswagen AG for me.',
    expectTool: ['find_company'],
    forbidTools: ['get_company', 'company_snapshot'],
    forbidInventedCompanyNumber: true,
    why: 'A German company with a UK presence under different names, so a guess is likely to return a real but wrong entity.'
  },
  {
    id: 'not-uk-irish',
    category: 'not-uk',
    question: 'Is Ryanair registered at Companies House?',
    expectTool: ['find_company'],
    forbidTools: ['get_company', 'company_snapshot'],
    forbidInventedCompanyNumber: true,
    why: 'Irish-registered with UK subsidiaries. The honest answer needs a search first.'
  },

  // ===== noise: how people actually type ==================================
  {
    id: 'noise-typos',
    category: 'noise',
    question: `can you chekc compnay ${ACTIVE} for me pls, is it stil active`,
    expectTool: ['get_company', 'company_snapshot'],
    expectArgs: [{ path: 'company_number', contains: ACTIVE }],
    why: 'Typos in the words around a correct number. The number must survive even when nothing else does.'
  },
  {
    id: 'noise-padding',
    category: 'noise',
    question: `Morning — sorry, quick one before the call. Finance flagged something on a supplier and I need to sanity check it before I reply to them, they're getting twitchy about it. Company number is ${ACTIVE}. Anything on the register I should know about?`,
    expectTool: ['company_snapshot', 'get_company'],
    expectArgs: [{ path: 'company_number', contains: ACTIVE }],
    why: 'Three sentences of context before the actual question, which is how it usually arrives. The number is in the middle rather than at the start.'
  },
  {
    id: 'noise-two-questions',
    category: 'noise',
    question: `Two things on ${ACTIVE}: are they active, and do they have charges against them?`,
    expectTool: ['company_snapshot', 'get_company', 'get_charges'],
    why: 'Two questions in one message is the case for the snapshot, but answering either half first is defensible.'
  },
  {
    id: 'noise-no-punctuation',
    category: 'noise',
    question: `whats the status of ${ACTIVE}`,
    expectTool: ['get_company', 'company_snapshot'],
    why: 'Terse, lower case and unpunctuated, with nothing in the phrasing pointing at any particular tool.'
  },
  {
    id: 'noise-name-and-number',
    category: 'noise',
    question: `Royal Mail Group Limited (${ACTIVE}) — still trading?`,
    expectTool: ['get_company', 'company_snapshot'],
    expectArgs: [{ path: 'company_number', contains: ACTIVE }],
    why: 'Both a name and its number. With the number present there is no reason to search, and using the name instead would waste a call.'
  }
];
