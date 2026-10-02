import { z } from "zod";
import { getContactsService, type ContactsService } from "../plugins/contacts.ts";
import { defineTool } from "./tool.ts";

type Person = {
  resourceName?: string;
  names?: { displayName?: string }[];
  emailAddresses?: { value?: string }[];
  phoneNumbers?: { value?: string }[];
  organizations?: { name?: string; title?: string }[];
};

function contact(person: Person, source: "contacts" | "other") {
  const organization = person.organizations?.[0];
  return {
    name: person.names?.[0]?.displayName ?? "",
    emails: (person.emailAddresses ?? []).flatMap((email) => email.value ? [email.value] : []),
    phones: (person.phoneNumbers ?? []).flatMap((phone) => phone.value ? [phone.value] : []),
    ...(organization?.name ? { organization: organization.name } : {}),
    ...(organization?.title ? { job_title: organization.title } : {}),
    source,
  };
}

export function createContactsTools(service: ContactsService = getContactsService()) {
  return [
    defineTool({
      name: "contacts_search",
      permission: { effect: "read", plugin: "contacts" },
      description: "Find people in the user's Google Contacts by name, email address, phone number or organization. Searches saved contacts first, then the other contacts Google keeps for people the user has emailed. Returns each person's name, email addresses, phone numbers, organization and job title, and whether they are a saved contact. Use it to find someone's address before emailing or inviting them, and confirm with the user when several people match. Needs the user's Google Contacts plugin connected and enabled.",
      input: z.object({
        query: z.string().trim().min(1).max(200).describe("Name, email, phone number or organization to look for. Matches the start of words."),
        max_results: z.number().int().min(1).max(30).default(10).describe("Most people to return from each source, 1–30."),
      }),
      async run({ query, max_results }, { userId }) {
        const saved = "names,emailAddresses,phoneNumbers,organizations";
        const other = "names,emailAddresses,phoneNumbers";
        const search = (path: string, readMask: string, text: string) =>
          service.request(userId, `${path}?${new URLSearchParams({ query: text, readMask, pageSize: String(text ? max_results : 1) })}`, "GET") as Promise<{ results?: { person: Person }[] }>;
        // Google asks for an empty search first so its search cache is up to date.
        await Promise.all([search("/v1/people:searchContacts", saved, ""), search("/v1/otherContacts:search", other, "")]);
        const [contacts, others] = await Promise.all([search("/v1/people:searchContacts", saved, query), search("/v1/otherContacts:search", other, query)]);
        const results = [
          ...(contacts.results ?? []).map(({ person }) => contact(person, "contacts")),
          ...(others.results ?? []).map(({ person }) => contact(person, "other")),
        ];
        // An "other contact" for an address already saved adds nothing.
        const seen = new Set(results.filter((item) => item.source === "contacts").flatMap((item) => item.emails.map((email) => email.toLowerCase())));
        return JSON.stringify(results.filter((item) => item.source === "contacts" || !item.emails.some((email) => seen.has(email.toLowerCase()))));
      },
    }),
  ];
}
