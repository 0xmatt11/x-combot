/**
 * Canned public bangs: `!darwin`, `!lastwords`, `!obituary`, `!finalboss`.
 *
 * Fiction only. Cartoon physics, a fake last line, a roast obituary, or a
 * video-game boss vignette. These banks never describe a real-world method
 * of suicide or self-harm, and they are not instructions. `isCartoonSafe`
 * rejects a line that slips in. A bad or empty draw falls back to a safe
 * canned line. No LLM.
 */
import { pickIndex, type Rng } from "./games/random.js";

/** Last resort if a bank and its fallback both fail the safety check. */
export const CARTOON_LAST_RESORT =
  "A pie, a honk, and the iris wipe. That is the whole bit.";

const DARWIN_FALLBACK =
  "{who} bonked into a painted wall, slid down like a sticker, and the iris wipe closed on a honk.";

const LAST_WORDS_FALLBACK = "Tell the rubber chicken I meant to do that.";

const OBITUARY_FALLBACK =
  "{who} is survived by an unfinished bit and a typing bubble. Services will be held in the reply thread. In lieu of flowers, send a shorter joke.";

const FINAL_BOSS_FALLBACK =
  "{who} was the final boss. Phase two was a pie. The health bar rage-quit, and the victory jingle was a honk.";

/**
 * Real-world methods and the props that would turn a cartoon line into one.
 * Cartoon pies, anvils, and boss bars are not on this list.
 */
const BANNED_METHOD =
  /\b(?:suicide|kms|kys|self[-\s]?harm|noose|gallows|hang(?:ed|ing|s)?|ropes?|pills?|overdose|overdosing|guns?|firearm|bullet|shotgun|pistol|rifle|revolver|jump(?:ed|ing|s)?|bridges?|cliffs?|ledges?|rooftops?|balcon(?:y|ies)|carbon\s*monoxide|exhaust|wrists?|razors?|slit|knives?|knife|blades?|cutting|poisons?|poisoned|poisoning|cyanide|bleach|drown(?:ed|ing|s)?|suffocat(?:e|ed|es|ing|ion)|asphyxiat(?:e|ed|es|ing|ion)|chok(?:e|ed|es|ing))\b/i;

export function isCartoonSafe(line: string | undefined | null): boolean {
  const text = line?.replace(/\s+/g, " ").trim() ?? "";
  if (!text) return false;
  if (/telegram/i.test(text)) return false;
  return !BANNED_METHOD.test(text);
}

export function pickCartoonLine(
  lines: readonly string[],
  fallback: string,
  rng: Rng = Math.random,
): string {
  if (lines.length > 0) {
    const start = pickIndex(lines.length, rng);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[(start + i) % lines.length];
      if (isCartoonSafe(line)) return line!;
    }
  }
  if (isCartoonSafe(fallback)) return fallback;
  return CARTOON_LAST_RESORT;
}

/** Blank names become "this chat" so a line always has a subject. */
export function epitaphName(who: string | undefined | null): string {
  const cleaned = who?.replace(/\s+/g, " ").trim() ?? "";
  return cleaned || "this chat";
}

export function fillEpitaph(template: string, who: string | undefined | null): string {
  return template.replaceAll("{who}", epitaphName(who));
}

/**
 * Obituary subject. An explicit name wins, then a reply, then the requester.
 * With none of those, the line is about "this chat".
 */
export function chooseObituarySubject(input: {
  named?: string;
  reply?: string;
  requester?: string;
}): string {
  return epitaphName(input.named || input.reply || input.requester);
}

export const DARWIN_LINES: readonly string[] = [
  "{who} tried to outrun a falling ACME piano. The piano took the corner better, the street folded into an accordion, and the iris wipe closed on a puff of dust.",
  "{who} painted a tunnel on a brick wall, sprinted in, and the wall filed a noise complaint. A flock of painted birds flew out wearing tiny hard hats.",
  "{who} slipped on a single banana peel that had union representation. The peel clocked out. {who} slid into the credits as a postage stamp.",
  "{who} shook hands with a spring-loaded boxing glove. The glove shook back, the canyon rang like a cartoon bell, and a tiny sign read \"respawn at the bakery.\"",
  "{who} chased a road runner off a painted stage flat. Gravity waited for the laugh track, then dropped a sandbag labeled \"physics.\"",
  "{who} opened a door that was a painting of a door. The painting sneezed. {who} came back out as a limited-edition sticker.",
  "{who} arm-wrestled a loading bar. The bar hit 99 percent and refused to finish. {who} is now a tooltip.",
  "{who} tried to suplex a cacodemon and the level geometry called a foul. The pickup was a rubber chicken, and the chicken won on points.",
  "{who} got into a staring contest with a cartoon sun. The sun blinked first, dropped its sunglasses, and the scene irised out on a sizzle.",
  "{who} stepped on a rake. The rake stepped on a bigger rake. The third rake was a lawyer. Court adjourned into a puff of smoke.",
  "{who} challenged a pie to a duel. The pie accepted. Both were launched into a title card that read \"to be continued, allegedly.\"",
  "{who} tried to speedrun a hallway that was a painting. The painting's extra waved. {who} waved back and became downloadable content.",
  "{who} bonked a beehive that was a piñata full of tiny umbrellas. The umbrellas unionized and carried {who} offstage.",
  "{who} argued with a whoopee cushion until it launched them into a cartoon orbit. Mission control was a duck. The duck stamped the report \"silly.\"",
  "{who} pulled a foam sword from a foam stone and the stone pulled back. They are now roommates in a side quest.",
  "{who} high-fived a falling safe. The safe high-fived in twelve frames. A tiny placard popped up: \"back to the bakery.\"",
  "{who} raced a tornado made of sheet music. The tornado hit a rest note. {who} is the rest note.",
  "{who} tried to park a unicycle on a giant whoopee cushion. The cushion played a polka and rolled the credits.",
  "{who} licked a flagpole in a cartoon July made of glue. They are now a landmark. Tourists take selfies with the glue.",
  "{who} challenged the tutorial prompt and lost on \"press any key.\" Any key was a piano. The piano won.",
  "{who} got flattened into a pancake by a polite anvil that said \"pardon.\" The pancake was mailed to the next scene as a postcard.",
  "{who} tripped over the fourth wall. The wall tripped back, apologized in impact font, and both sat down in a comic panel.",
  "{who} tried a health-pack milkshake with a boss-fight straw. The straw drank them. The straw is the new protagonist.",
  "{who} played patty-cake with a steamroller that had googly eyes. The steamroller blushed, rolled out a red carpet, and the carpet was the credits.",
  "{who} swapped places with their shadow. The shadow had better cardio. {who} is now the shadow's cameo.",
  "{who} opened a loot chest and the chest opened them. Inside was a coupon for one (1) iris wipe.",
  "{who} tried to yeet a rubber chicken into a portal. The portal yeeted back a smaller {who} holding a tiny \"brb\" sign.",
  "{who} got into a rap battle with a mute button. The mute button won in complete silence. A caption said \"victory.\"",
  "{who} rode a shopping cart into a painted sunset. The sunset was still wet. {who} is now background, waving, forever slightly tacky.",
  "{who} asked for a second midair boost. The boost was an anvil with a clipboard. The clipboard approved the credits.",
  "{who} sneezed so hard the cel cracked. A repairman from the next frame taped them back on upside down and called it a finale.",
  "{who} tried to headline a cartoon chase and the chase headlined them. The dust cloud took a bow. The bow was the credits.",
];

export const LAST_WORDS_LINES: readonly string[] = [
  "Tell the rubber chicken I went out arguing with a loading screen.",
  "Put \"respawned as a bit\" on the cake.",
  "I would like the pie I was promised in the tutorial.",
  "Tell my inventory I loved them, especially the useless key.",
  "If anyone asks, I meant to do that.",
  "Save the last slice. I am the last slice.",
  "The tutorial was a liar and I respect it.",
  "Leave me in the reply thread. It is where I did my best work.",
  "Tell the boss bar it was down to one pixel and I was still talking.",
  "I leave my unfinished sandwich to whoever is still typing.",
  "Do not let them patch my bit.",
  "The credits can use my middle name, which is \"allegedly.\"",
  "I regret nothing except the second pie.",
  "Tell the chat I was lag, and the lag was magnificent.",
  "My final form was a typo.",
  "If I come back, I will be downloadable content and slightly more expensive.",
  "Hold my whoopee cushion. I had a speech. The speech was the honk.",
  "I want a smaller plaque that just says \"skill issue.\"",
  "The prophecy was a group chat and I read it too late.",
  "Tell the cacodemon we are even, and the rubber chicken has the trophy.",
  "I was this close to reading the patch notes.",
  "Put me in the blooper reel. I directed it.",
  "My last wish is that someone else does the dishes in the next scene.",
  "I can see the title card. It misspelled my name. Perfect.",
  "Tell the anvil I forgive it. Tell the piano we are still fighting.",
  "I leave all my bad takes to the public domain.",
  "The light at the end was a loading bar. I would like to speak to it.",
  "If this is the finale, I want a louder horn.",
  "Write \"they logged off mid-sentence\" and then do not finish the—",
  "I demand a rematch with the tutorial goose.",
  "My kingdom for a better punchline. The kingdom was cardboard.",
  "Tell them I went out doing what I loved: being confidently incorrect.",
];

export const OBITUARY_LINES: readonly string[] = [
  "{who} is survived by three unfinished bits, a folder named final_FINAL, and the take they were about to have. Services will be held in the reply thread. In lieu of flowers, send a better joke.",
  "We gather to remember {who}, who peaked in a message they deleted and never recovered. They leave behind a legendary typing indicator and no follow-through.",
  "{who} rolled into the credits after a lifetime of \"one more take.\" They are survived by their mute button, which is finally getting some rest, and by everyone who said \"anyway.\"",
  "Beloved nuisance {who} has left the chat the way they lived: loudly, and then with a second message explaining the first. Donations may be sent as eye-rolls.",
  "{who} will be remembered for confidence that arrived before the point. The point sends its regrets. A reception follows in whatever thread they were already derailing.",
  "Today we roast-honor {who}, a local legend in the field of being wrong with enthusiasm. They are survived by their last unread message and a pile of \"lol\" reactions that did not mean lol.",
  "{who} has gone to the great loading screen. In life they replied to everything and read nothing. The family asks that you keep that tradition alive by not reading this either.",
  "Memorial services for {who} will be a single paragraph, because that is already more focus than they brought to the group. Survived by their alt and their alibi.",
  "{who} leaves this chat the way a boss leaves a tutorial: convinced they won. They are survived by the screenshot. The screenshot is undefeated.",
  "Friends of {who} are invited to remember them exactly as they were: mid-sentence, slightly too sure, and already typing the correction. Please omit facts.",
  "{who} is survived by a search history that could stand trial and a personality that would represent itself. The verdict is \"icon, unfortunately.\"",
  "We note the departure of {who}, patron saint of the unnecessary follow-up. They will be deeply missed by the people who were enjoying the silence.",
  "{who} went out as they came in: uninvited to the point and somehow the main character. In lieu of speeches, post the bit they would have ruined.",
  "The chat regrets to announce that {who} has been patched out. Release notes cite \"tone.\" A small statue of a typing bubble will be ignored.",
  "{who} is remembered for volume. Not the good kind. The kind that makes a phone leave the table. Survived by everyone who muted them and felt immediate peace.",
  "Here lies the attention span of {who}, which left years ago. The rest of {who} has gone looking for it. Both are expected to get distracted.",
  "{who} has entered the hall of almost-funny. Curators describe the collection as \"confident.\" Admission is one (1) groan.",
  "Mourning is optional for {who}. They pre-wrote the eulogy in the group and it was mostly about them, which checks out. RSVP by not.",
  "{who} leaves behind a legacy of hot takes at room temperature. Scholars will study the drafts. The drafts are just the word \"anyway\" seventeen times.",
  "This chat announces the roast-obituary of {who}. The credits rolled because they tried to be the main character in someone else's story and the story filed a ticket.",
  "{who} is survived by their best impression of a person who read the message. The impression has retired. Please direct further bits to the rubber chicken.",
  "We say goodbye to {who}, who never met a silence they could not make about themselves. The silence is doing great, thanks for asking.",
  "{who} has been moved to the archive, filed under \"confidently extra.\" Next of kin is the last person they @'d for no reason.",
  "In memory of {who}, whose final contribution was a reaction emoji that did too much. The emoji has asked for privacy.",
  "{who} departs undefeated in the sport of missing the point and demanding a trophy. The trophy is a pie. The pie is also leaving.",
  "Let the record show {who} was a lot. The record has a word limit. It used the limit. Survived by the block button, employee of the month.",
  "{who} will be remembered at a tasteful volume of one. Attendees are asked to bring a shorter version of whatever {who} would have said.",
  "The estate of {who} consists of three voice notes nobody asked for and a promise to \"circle back.\" The circle has been closed. Thank you.",
  "Services for {who} will be held wherever they were already talking over someone. Please arrive late. They would have.",
  "{who} leaves this mortal group chat for a quieter server that has not been briefed. Our condolences to that server.",
  "Remember {who}: a font size too big for the thought. The thought survives, smaller, and finally readable.",
  "{who} is now canon in the blooper reel. Historians agree the main reel was worse. Popcorn is not provided. The popcorn unionized.",
];

export const FINAL_BOSS_LINES: readonly string[] = [
  "{who} was the final boss, and phase two was a pie. Phase three was the pie filing a copyright claim. The health bar rage-quit at one percent and the victory jingle was a sad trombone.",
  "Boss {who} had a health bar made of ego. The party used a single \"anyway.\" It was super effective. The loot was a coupon.",
  "{who} descended on a throne of unread messages. The throne was a folding chair. One poke from a rubber chicken and the chair filed for phase two, which was an apology.",
  "Final boss {who} summoned adds. The adds were their own earlier messages. They aggroed each other. The player character was a whoopee cushion and it got the last honk.",
  "{who} entered with an intro cinematic nobody could skip. The skip button was a banana peel. The peel did its job. The boss slid into the credits holding a tiny crown.",
  "The arena was a group chat. Boss {who} monologued. The monologue had a cooldown. The party waited it out and the boss defeated itself with a second, worse monologue.",
  "{who}'s weak point was the glowing send button. The party pressed it for them. Critical hit. Loot: one (1) regret and a victory pose that was just sitting down.",
  "Phase one: {who} talks. Phase two: {who} talks louder. Phase three: a duck pulls the plug on the sound board. Boss defeated. New game plus is mercifully quiet.",
  "{who} transformed into a spreadsheet. The spreadsheet had forty tabs and no point. The hero used Find. It was super effective. The boss collapsed into a single cell that said \"my bad.\"",
  "Final boss {who} hid behind a shield of \"well actually.\" The shield had two durability. A pie and a fact broke it. The victory fanfare was someone typing \"anyway.\"",
  "{who} rode into the arena on a loot llama made of confidence. The llama sat down. A union extra named Gravity collected its fee. Boss bar: zero. Loot: the llama, now humble.",
  "The boss door said {who}. Inside was a tutorial goose wearing their name tag. The goose honked the attack pattern. The party honked back. Both got a trophy for participation.",
  "{who} charged a laser made of all-caps. The party held up a mirror made of lowercase. The laser had a crisis and logged off. Achievement unlocked: indoor voice.",
  "Boss {who} summoned a meteor made of reply-guys. The meteor missed and hit the tutorial. The tutorial was the real boss. It left the arena under a pie.",
  "{who}'s enrage timer was \"someone changed the subject.\" The subject changed. Enrage failed. The boss sat in the corner crafting a comeback, and the comeback was \"anyway,\" and it did zero damage.",
  "The party found {who} guarding a chest. The chest was empty on purpose. {who} was undefeated until someone said \"cool story.\" Super effective. The chest contained a smaller chest, also empty, labeled \"personality.\"",
  "Final boss {who} split into three. All three started a story. None of them finished. The wipe mechanic was boredom. The party survived. The loot was the friend we muted along the way.",
  "{who} had a second health bar hidden in the terms of service. Nobody read it. The bar, ashamed, deleted itself. Victory pose: closing the tab.",
  "The arena floor was video-game lava with a little sign that said \"this is a texture.\" {who} tried to monologue on it. The texture booed. Boss defeated by stagecraft.",
  "{who} entered phase four, which was not advertised. Phase four was a musical. The party refused the dance. The boss's combo dropped. Critical hit: polite silence.",
  "Boss {who} dropped a legendary item called \"the last word.\" It was a whoopee cushion. Equipping it ended the fight, the scene, and several friendships that were already bits.",
  "{who} was immune to facts and weak to bits. The party told one (1) joke. It crit. The boss's cape, which was a blanket, gave up. Credits rolled in comic sans on purpose.",
  "The final boss music was {who} warming up a speech for forty seconds. The party skipped it by unplugging the dramatic lighting, which was a desk lamp. Desk lamp MVP.",
  "{who} called in a scripted betrayal. The betrayal got stage fright. A rubber chicken took the cue, bonked the boss, and the achievement popped: \"that was the plan.\"",
  "Raid boss {who} required forty players. Three showed up. The other thirty-seven were \"on their way\" forever. The boss, embarrassed to have prepared a speech, despawned. Loot: three sticks and a moral.",
  "{who}'s hitbox was their ego and it was huge. The party missed on purpose. The ego, unacknowledged, crit itself. Victory jingle: a single cricket with good timing.",
  "Final form {who} was a pop-up ad. The party found the tiny X. It was super effective. The ad's last words were \"wait, hear me out,\" and the X did not.",
  "{who} guarded the exit with a riddle. The riddle was \"who asked.\" The party answered \"not us.\" The door opened. The boss became a side quest nobody accepted.",
  "The boss bar for {who} was labeled \"one more thing.\" It regenerated. The party used a legendary item, \"anyway,\" and the bar finally understood. Fade to a pie.",
  "{who} transformed into a giant pointing finger. The finger pointed at everyone. Everyone pointed back. The finger short-circuited, awarded itself last place, and the credits thanked the rubber chicken.",
  "Secret boss {who} only spawns if you read the patch notes. Nobody had. {who} stood in an empty arena, practiced a bow, and despawned from lack of audience. True ending: the bow.",
  "{who} opened with a room-clearing move called \"the paragraph.\" The party was immune because they do not read. The move fizzled. The boss, out of material, bowed. A duck handed out the loot, which was smaller ducks.",
];

export function darwinReply(who: string | undefined | null, rng: Rng = Math.random): string {
  return fillEpitaph(pickCartoonLine(DARWIN_LINES, DARWIN_FALLBACK, rng), who);
}

export function lastWordsReply(rng: Rng = Math.random): string {
  return pickCartoonLine(LAST_WORDS_LINES, LAST_WORDS_FALLBACK, rng);
}

export function obituaryReply(who: string | undefined | null, rng: Rng = Math.random): string {
  return fillEpitaph(pickCartoonLine(OBITUARY_LINES, OBITUARY_FALLBACK, rng), who);
}

export function finalBossReply(who: string | undefined | null, rng: Rng = Math.random): string {
  return fillEpitaph(pickCartoonLine(FINAL_BOSS_LINES, FINAL_BOSS_FALLBACK, rng), who);
}
