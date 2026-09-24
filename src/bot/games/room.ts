/**
 * In-memory multiplayer games. One live session per conversation and kind.
 * The map key is conversation id plus game id. Pending challenges expire
 * sooner than a game that is already being played.
 */
import type { Rng } from "./random.js";
import { namedPlayer, type GamePlayer } from "./players.js";
import {
  CONNECT4_HELP,
  connect4Mark,
  connect4Player,
  connect4Seat,
  dropConnect4,
  emptyConnect4,
  parseConnect4Column,
  renderConnect4,
  connect4Winner,
  type Connect4State,
} from "./connect4.js";
import {
  DUEL_HELP,
  duelHpLine,
  duelPlayer,
  duelSeat,
  emptyDuel,
  otherSeat,
  parseDuelAction,
  rollD6,
  type DuelState,
} from "./duel.js";
import {
  HANGMAN_HELP,
  emptyHangman,
  hangmanMask,
  hangmanPlayer,
  hangmanSeat,
  hangmanSolved,
  parseHangmanGuess,
  pickHangmanWord,
  type HangmanState,
} from "./hangman.js";
import {
  STORY_HELP,
  STORY_MAX_LINES,
  emptyStory,
  parseStoryArgs,
  type StoryState,
} from "./story.js";
import {
  TICTACTOE_HELP,
  emptyTictactoe,
  parseTictactoeSquare,
  renderTictactoe,
  tictactoeMark,
  tictactoePlayer,
  tictactoeSeat,
  tictactoeWinner,
  type Seat,
  type TictactoeState,
} from "./tictactoe.js";

export const CHALLENGE_TTL_MS = 10 * 60 * 1000;
export const PLAY_TTL_MS = 30 * 60 * 1000;
export const STORY_TTL_MS = 2 * 60 * 60 * 1000;

export type MultiplayerKind = "tictactoe" | "connect4" | "duel" | "hangman" | "story";

export type PlayInput = {
  conversationId: string;
  actor: GamePlayer;
  /** Set when the command @mentions someone, or replies to them with no other args. */
  challenged?: GamePlayer;
  args: string;
  nowMs: number;
};

type LiveSession = TictactoeState | Connect4State | DuelState | HangmanState | StoryState;

const ACCEPT = new Set(["accept", "yes", "y", "join"]);
const DECLINE = new Set(["decline", "reject", "no"]);
const RESIGN = new Set(["resign", "forfeit", "quit", "cancel", "ff"]);
const STATUS = new Set(["status", "board", "show"]);

const HELP: Record<MultiplayerKind, string> = {
  tictactoe: TICTACTOE_HELP,
  connect4: CONNECT4_HELP,
  duel: DUEL_HELP,
  hangman: HANGMAN_HELP,
  story: STORY_HELP,
};

const NOUN: Record<MultiplayerKind, string> = {
  tictactoe: "tic-tac-toe",
  connect4: "connect four",
  duel: "duel",
  hangman: "hangman",
  story: "story",
};

/** "challenged Ada to …" */
const CHALLENGE_NAME: Record<Exclude<MultiplayerKind, "story">, string> = {
  tictactoe: "tic-tac-toe",
  connect4: "connect four",
  duel: "a duel",
  hangman: "hangman",
};

const OPENING: Record<Exclude<MultiplayerKind, "story">, string> = {
  tictactoe: "accept, decline, or play 1-9",
  connect4: "accept, decline, or drop a column 1-7",
  duel: "accept, decline, or !duel attack / !duel defend",
  hangman: "accept, decline, or guess a letter",
};

const COMMAND: Record<MultiplayerKind, string> = {
  tictactoe: "!tictactoe",
  connect4: "!connect4",
  duel: "!duel",
  hangman: "!hangman",
  story: "!story",
};

export class GameRoom {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly live = new Map<string, string>();
  private seq = 0;

  constructor(private readonly rng: Rng = Math.random) {}

  /** How many sessions are still stored. Expired ones are removed on the next command. */
  size(): number {
    return this.sessions.size;
  }

  /** Map keys are `conversationId:gameId`. */
  sessionKeys(): string[] {
    return [...this.sessions.keys()];
  }

  play(kind: MultiplayerKind, input: PlayInput): string {
    const actor = namedPlayer(input.actor.id, input.actor.label);
    const challenged = input.challenged
      ? namedPlayer(input.challenged.id, input.challenged.label)
      : undefined;
    const args = input.args.trim();
    const expired = this.takeExpired(input.conversationId, kind, input.nowMs);
    this.sweep(input.nowMs);

    if (kind === "story") {
      return this.playStory(input.conversationId, actor, args, input.nowMs, expired);
    }
    if (kind === "hangman") {
      return this.playHangman(
        input.conversationId,
        actor,
        challenged,
        args,
        input.nowMs,
        expired,
      );
    }
    return this.playVersus(kind, input.conversationId, actor, challenged, args, input.nowMs, expired);
  }

  private playVersus(
    kind: "tictactoe" | "connect4" | "duel",
    conversationId: string,
    actor: GamePlayer,
    challenged: GamePlayer | undefined,
    args: string,
    nowMs: number,
    expired: boolean,
  ): string {
    if (challenged) {
      if (args) return HELP[kind];
      if (challenged.id === actor.id) return "Pick someone else.";
      if (this.current(conversationId, kind)) return this.already(kind);
      return this.openChallenge(kind, conversationId, actor, challenged, nowMs);
    }
    const session = this.current(conversationId, kind);
    if (!session || session.kind === "hangman" || session.kind === "story") {
      return expired ? this.timedOut(kind) : HELP[kind];
    }
    this.touch(session, nowMs);
    const verb = args.toLowerCase();
    if (!args || STATUS.has(verb)) return this.versusStatus(session);
    if (RESIGN.has(verb)) return this.resign(session, actor);
    if (session.phase === "pending") return this.pendingVersus(session, actor, args);
    if (session.kind === "tictactoe") return this.activeTictactoe(session, actor, args);
    if (session.kind === "connect4") return this.activeConnect4(session, actor, args);
    return this.activeDuel(session, actor, args);
  }

  private openChallenge(
    kind: "tictactoe" | "connect4" | "duel" | "hangman",
    conversationId: string,
    actor: GamePlayer,
    challenged: GamePlayer,
    nowMs: number,
  ): string {
    const id = this.nextId();
    if (kind === "tictactoe") {
      this.save(emptyTictactoe(id, conversationId, actor, challenged, nowMs));
    } else if (kind === "connect4") {
      this.save(emptyConnect4(id, conversationId, actor, challenged, nowMs));
    } else if (kind === "duel") {
      this.save(emptyDuel(id, conversationId, actor, challenged, nowMs));
    } else {
      this.save(
        emptyHangman(id, conversationId, actor, nowMs, pickHangmanWord(this.rng), challenged),
      );
    }
    return `${actor.label} challenged ${challenged.label} to ${CHALLENGE_NAME[kind]}. ${challenged.label}: ${COMMAND[kind]} ${OPENING[kind]}.`;
  }

  private pendingVersus(
    session: TictactoeState | Connect4State | DuelState,
    actor: GamePlayer,
    args: string,
  ): string {
    const seat = seatOf(session, actor.id);
    if (!seat) return this.spectating(session);
    const verb = args.toLowerCase();
    if (seat === "challenger") {
      return `Waiting for ${session.opponent.label} to accept.`;
    }
    if (ACCEPT.has(verb)) return this.accept(session);
    if (DECLINE.has(verb)) return this.decline(session, actor);
    if (session.kind === "tictactoe" && parseTictactoeSquare(args) !== undefined) {
      return this.activeTictactoe(this.acceptByMove(session, "opponent"), actor, args);
    }
    if (session.kind === "connect4" && parseConnect4Column(args) !== undefined) {
      return this.activeConnect4(this.acceptByMove(session, "opponent"), actor, args);
    }
    if (session.kind === "duel" && parseDuelAction(args)) {
      return this.activeDuel(this.acceptByMove(session, "opponent"), actor, args);
    }
    return `${session.opponent.label}: ${COMMAND[session.kind]} ${OPENING[session.kind]}.`;
  }

  private accept(session: TictactoeState | Connect4State | DuelState): string {
    session.phase = "active";
    session.turn = "challenger";
    if (session.kind === "tictactoe" || session.kind === "connect4") {
      session.xSeat = "challenger";
    }
    return this.versusStatus(session);
  }

  /** The challenged player moves first, so they are X (or the duel actor). */
  private acceptByMove<T extends TictactoeState | Connect4State | DuelState>(
    session: T,
    seat: Seat,
  ): T {
    session.phase = "active";
    session.turn = seat;
    if (session.kind === "tictactoe" || session.kind === "connect4") {
      session.xSeat = seat;
    }
    return session;
  }

  private activeTictactoe(session: TictactoeState, actor: GamePlayer, args: string): string {
    const seat = tictactoeSeat(session, actor.id);
    if (!seat) return this.spectating(session);
    if (session.turn !== seat) return this.notTurn(session, session.turn);
    const index = parseTictactoeSquare(args);
    if (index === undefined) return "Squares are 1-9.";
    if (session.cells[index]) return "That square is taken.";
    const mark = tictactoeMark(session, seat);
    if (!mark) return "Squares are 1-9.";
    session.cells[index] = mark;
    const winner = tictactoeWinner(session.cells);
    const board = renderTictactoe(session.cells);
    if (winner === "draw") {
      this.remove(session);
      return `${board}\nDraw.`;
    }
    if (winner) {
      this.remove(session);
      return `${board}\n${actor.label} wins.`;
    }
    session.turn = otherSeat(seat);
    const next = tictactoePlayer(session, session.turn);
    const nextMark = tictactoeMark(session, session.turn);
    return `${board}\n${next.label} (${nextMark}) — play 1-9.`;
  }

  private activeConnect4(session: Connect4State, actor: GamePlayer, args: string): string {
    const seat = connect4Seat(session, actor.id);
    if (!seat) return this.spectating(session);
    if (session.turn !== seat) return this.notTurn(session, session.turn);
    const col = parseConnect4Column(args);
    if (col === undefined) return "Columns are 1-7.";
    const mark = connect4Mark(session, seat);
    if (!mark) return "Columns are 1-7.";
    const row = dropConnect4(session.grid, col, mark);
    if (row === undefined) return `Column ${col + 1} is full.`;
    const winner = connect4Winner(session.grid);
    const board = renderConnect4(session.grid);
    if (winner === "draw") {
      this.remove(session);
      return `${board}\nDraw.`;
    }
    if (winner) {
      this.remove(session);
      return `${board}\n${actor.label} wins.`;
    }
    session.turn = otherSeat(seat);
    const next = connect4Player(session, session.turn);
    const nextMark = connect4Mark(session, session.turn);
    return `${board}\n${next.label} (${nextMark}) — column 1-7.`;
  }

  private activeDuel(session: DuelState, actor: GamePlayer, args: string): string {
    const seat = duelSeat(session, actor.id);
    if (!seat) return this.spectating(session);
    if (session.turn !== seat) return this.notTurn(session, session.turn);
    const action = parseDuelAction(args);
    if (!action) return "Attack with !duel attack, or !duel defend.";
    const foe = otherSeat(seat);
    if (action === "defend") {
      const block = rollD6(this.rng);
      session.block[seat] = block;
      session.turn = foe;
      return `🛡️ ${actor.label} defends (block ${block}). ${duelHpLine(session)} ${duelPlayer(session, foe).label}'s turn.`;
    }
    const roll = rollD6(this.rng);
    const blocked = session.block[foe];
    const dealt = Math.max(0, roll - blocked);
    session.block[foe] = 0;
    session.hp[foe] = Math.max(0, session.hp[foe] - dealt);
    const target = duelPlayer(session, foe);
    if (session.hp[foe] <= 0) {
      this.remove(session);
      return `⚔️ ${actor.label} hits ${target.label} for ${dealt}. ${target.label} is out. ${actor.label} wins.`;
    }
    session.turn = foe;
    const hit =
      blocked > 0
        ? `${actor.label} hits ${target.label} for ${dealt} (roll ${roll}, block ${blocked}).`
        : `${actor.label} hits ${target.label} for ${dealt}.`;
    return `⚔️ ${hit} ${duelHpLine(session)} ${target.label}'s turn.`;
  }

  private playHangman(
    conversationId: string,
    actor: GamePlayer,
    challenged: GamePlayer | undefined,
    args: string,
    nowMs: number,
    expired: boolean,
  ): string {
    const verb = args.toLowerCase();
    if (challenged) {
      if (args) return HANGMAN_HELP;
      if (challenged.id === actor.id) return "Pick someone else.";
      if (this.current(conversationId, "hangman")) return this.already("hangman");
      return this.openChallenge("hangman", conversationId, actor, challenged, nowMs);
    }
    if (!args || verb === "start" || verb === "play" || verb === "solo") {
      const existing = this.current(conversationId, "hangman");
      if (!args && existing && existing.kind === "hangman") {
        this.touch(existing, nowMs);
        return this.hangmanStatus(existing);
      }
      if (verb === "start" || verb === "play" || verb === "solo") {
        if (existing) return this.already("hangman");
        const session = emptyHangman(
          this.nextId(),
          conversationId,
          actor,
          nowMs,
          pickHangmanWord(this.rng),
        );
        this.save(session);
        return this.hangmanStatus(session);
      }
    }
    const session = this.current(conversationId, "hangman");
    if (!session || session.kind !== "hangman") {
      return expired ? this.timedOut("hangman") : HANGMAN_HELP;
    }
    this.touch(session, nowMs);
    if (!args || STATUS.has(verb)) return this.hangmanStatus(session);
    if (RESIGN.has(verb)) return this.resignHangman(session, actor);
    if (session.phase === "pending") return this.pendingHangman(session, actor, args);
    return this.guessHangman(session, actor, args);
  }

  private pendingHangman(session: HangmanState, actor: GamePlayer, args: string): string {
    const seat = hangmanSeat(session, actor.id);
    if (!seat) return this.spectating(session);
    if (seat === "challenger") return `Waiting for ${session.opponent?.label ?? "someone"} to accept.`;
    const verb = args.toLowerCase();
    // "y" is a letter guess, not a short accept. "yes" still accepts.
    if (ACCEPT.has(verb) && verb !== "y") {
      session.phase = "active";
      session.turn = "challenger";
      return this.hangmanStatus(session);
    }
    if (DECLINE.has(verb)) return this.decline(session, actor);
    if (parseHangmanGuess(args)) {
      session.phase = "active";
      session.turn = "opponent";
      return this.guessHangman(session, actor, args);
    }
    const who = session.opponent?.label ?? "someone";
    return `${who}: !hangman accept, decline, or guess a letter to start.`;
  }

  private guessHangman(session: HangmanState, actor: GamePlayer, args: string): string {
    const seat = hangmanSeat(session, actor.id);
    if (!seat) return this.spectating(session);
    if (session.mode === "versus" && session.turn !== seat) {
      return this.notTurn(session, session.turn);
    }
    if (session.mode === "solo" && seat !== "challenger") return this.spectating(session);
    const guess = parseHangmanGuess(args);
    if (!guess) return "Guess a letter with !hangman e, or the whole word.";
    if (guess.kind === "word") {
      if (guess.word === session.word) {
        this.remove(session);
        return `🪢 ${actor.label} got it: ${session.word}.`;
      }
      session.lives -= 1;
      if (session.lives <= 0) {
        const word = session.word;
        this.remove(session);
        return `🪢 Out of lives. The word was ${word}.`;
      }
      this.advanceHangman(session, seat);
      return `🪢 Nope.\n${this.hangmanStatus(session)}`;
    }
    if (session.guessed.includes(guess.letter)) return `Already guessed ${guess.letter}.`;
    session.guessed.push(guess.letter);
    const hit = session.word.includes(guess.letter);
    if (!hit) session.lives -= 1;
    if (hangmanSolved(session.word, session.guessed)) {
      const word = session.word;
      this.remove(session);
      return `🪢 ${actor.label} got it: ${word}.`;
    }
    if (session.lives <= 0) {
      const word = session.word;
      this.remove(session);
      return `🪢 Out of lives. The word was ${word}.`;
    }
    this.advanceHangman(session, seat);
    return this.hangmanStatus(session);
  }

  private advanceHangman(session: HangmanState, seat: Seat): void {
    if (session.mode === "versus") session.turn = otherSeat(seat);
  }

  private hangmanStatus(session: HangmanState): string {
    const mask = hangmanMask(session.word, session.guessed);
    const guessed = session.guessed.length > 0 ? session.guessed.join(" ") : "none";
    const header = `🪢 ${mask}\nLives: ${session.lives}. Guessed: ${guessed}.`;
    if (session.phase === "pending") {
      const who = session.opponent?.label ?? "someone";
      return `${header}\nWaiting for ${who} to accept.`;
    }
    if (session.mode === "solo") {
      return `${header}\n${session.challenger.label}, guess a letter.`;
    }
    const turn = session.turn ? hangmanPlayer(session, session.turn) : session.challenger;
    return `${header}\n${turn.label}'s guess.`;
  }

  private resignHangman(session: HangmanState, actor: GamePlayer): string {
    const seat = hangmanSeat(session, actor.id);
    if (!seat) return this.spectating(session);
    if (session.phase === "pending") {
      if (seat === "challenger") {
        this.remove(session);
        return `${actor.label} cancelled the hangman challenge.`;
      }
      return this.decline(session, actor);
    }
    if (session.mode === "solo") {
      const word = session.word;
      this.remove(session);
      return `${actor.label} resigned. The word was ${word}.`;
    }
    const winner = seat === "challenger" ? session.opponent : session.challenger;
    const word = session.word;
    this.remove(session);
    return `${actor.label} resigned. ${winner?.label ?? "someone"} wins. The word was ${word}.`;
  }

  private playStory(
    conversationId: string,
    actor: GamePlayer,
    args: string,
    nowMs: number,
    expired: boolean,
  ): string {
    const intent = parseStoryArgs(args);
    const existing = this.current(conversationId, "story");
    const session = existing && existing.kind === "story" ? existing : undefined;
    if (!session) {
      if (expired && intent.type !== "start") return this.timedOut("story");
      if (intent.type === "start") {
        const created = emptyStory(this.nextId(), conversationId, actor, nowMs);
        this.save(created);
        if (!intent.sentence) return `📖 ${actor.label} started a story. Add one sentence with !story <sentence>.`;
        return this.addStoryLine(created, actor, intent.sentence);
      }
      if (intent.type === "bad-sentence") return "Add one sentence (140 characters max).";
      return STORY_HELP;
    }
    this.touch(session, nowMs);
    if (intent.type === "usage" || intent.type === "status") return this.storyStatus(session);
    if (intent.type === "start") return "A story is already going. !story status, or add a sentence.";
    if (intent.type === "stop") return this.stopStory(session, actor);
    if (intent.type === "bad-sentence") return "Add one sentence (140 characters max).";
    return this.addStoryLine(session, actor, intent.text);
  }

  private addStoryLine(session: StoryState, actor: GamePlayer, text: string): string {
    const last = session.lines[session.lines.length - 1];
    if (last && last.player.id === actor.id) {
      return `${actor.label} already added a line. Someone else goes next.`;
    }
    if (session.lines.length >= STORY_MAX_LINES) {
      return "This story is full. !story stop to end it.";
    }
    session.lines.push({ player: actor, text });
    return `📖 ${actor.label}: ${text}\n${this.storyStatus(session)}`;
  }

  private storyStatus(session: StoryState): string {
    const count = session.lines.length;
    const last = session.lines[count - 1];
    if (!last) return "📖 No lines yet. Anyone can add the first sentence.";
    return `📖 ${count} ${count === 1 ? "line" : "lines"}. Last: ${last.player.label} — ${last.text}\nNext: anyone but ${last.player.label}.`;
  }

  private stopStory(session: StoryState, actor: GamePlayer): string {
    const lines = session.lines;
    this.remove(session);
    if (lines.length === 0) return `📖 ${actor.label} ended the story before it started.`;
    const body = clipStory(lines.map((line) => line.text).join(" "));
    return `📖 ${actor.label} ended the story (${lines.length} ${lines.length === 1 ? "line" : "lines"}).\n${body}`;
  }

  private versusStatus(session: TictactoeState | Connect4State | DuelState): string {
    if (session.phase === "pending") {
      return `${session.challenger.label} challenged ${session.opponent.label} to ${CHALLENGE_NAME[session.kind]}. Waiting on ${session.opponent.label}.`;
    }
    if (session.kind === "tictactoe") {
      const turn = session.turn ? tictactoePlayer(session, session.turn) : session.challenger;
      const mark = session.turn ? tictactoeMark(session, session.turn) : "X";
      return `${renderTictactoe(session.cells)}\n${turn.label} (${mark}) — play 1-9.`;
    }
    if (session.kind === "connect4") {
      const turn = session.turn ? connect4Player(session, session.turn) : session.challenger;
      const mark = session.turn ? connect4Mark(session, session.turn) : "X";
      return `${renderConnect4(session.grid)}\n${turn.label} (${mark}) — column 1-7.`;
    }
    const turn = session.turn ? duelPlayer(session, session.turn) : session.challenger;
    return `${duelHpLine(session)} ${turn.label}'s turn: !duel attack or !duel defend.`;
  }

  private resign(session: TictactoeState | Connect4State | DuelState, actor: GamePlayer): string {
    const seat = seatOf(session, actor.id);
    if (!seat) return this.spectating(session);
    if (session.phase === "pending") {
      if (seat === "challenger") {
        this.remove(session);
        return `${actor.label} cancelled the ${NOUN[session.kind]} challenge.`;
      }
      return this.decline(session, actor);
    }
    const winner = seat === "challenger" ? session.opponent : session.challenger;
    this.remove(session);
    if (session.kind === "duel") return `${actor.label} resigned. ${winner.label} wins.`;
    const board =
      session.kind === "tictactoe" ? renderTictactoe(session.cells) : renderConnect4(session.grid);
    return `${actor.label} resigned. ${winner.label} wins.\n${board}`;
  }

  private decline(
    session: TictactoeState | Connect4State | DuelState | HangmanState,
    actor: GamePlayer,
  ): string {
    const challenger = session.challenger.label;
    this.remove(session);
    return `${actor.label} declined ${challenger}'s ${NOUN[session.kind]} challenge.`;
  }

  private spectating(session: LiveSession): string {
    if (session.kind === "story") return this.storyStatus(session);
    if (session.kind === "hangman") {
      if (session.mode === "solo") return `That's ${session.challenger.label}'s hangman game.`;
      return `That's ${session.challenger.label} vs ${session.opponent?.label ?? "someone"}.`;
    }
    return `That's ${session.challenger.label} vs ${session.opponent.label}.`;
  }

  private notTurn(session: { challenger: GamePlayer; opponent?: GamePlayer }, turn: Seat | undefined): string {
    if (!turn) return "Waiting on a player.";
    const player = turn === "challenger" ? session.challenger : session.opponent;
    return `It's ${player?.label ?? "someone"}'s turn.`;
  }

  private already(kind: MultiplayerKind): string {
    return `A ${NOUN[kind]} game is already going. ${COMMAND[kind]} status, or ${COMMAND[kind]} resign.`;
  }

  private timedOut(kind: MultiplayerKind): string {
    return `That ${NOUN[kind]} game timed out. Start again with ${COMMAND[kind]}.`;
  }

  private sweep(nowMs: number): void {
    for (const session of [...this.sessions.values()]) {
      if (nowMs - session.updatedAt >= ttl(session)) this.remove(session);
    }
  }

  private takeExpired(conversationId: string, kind: MultiplayerKind, nowMs: number): boolean {
    const session = this.current(conversationId, kind);
    if (!session) return false;
    if (nowMs - session.updatedAt < ttl(session)) return false;
    this.remove(session);
    return true;
  }

  private current(conversationId: string, kind: MultiplayerKind): LiveSession | undefined {
    const key = this.live.get(indexKey(conversationId, kind));
    if (!key) return undefined;
    return this.sessions.get(key);
  }

  private save(session: LiveSession): void {
    const key = sessionKey(session.conversationId, session.id);
    this.sessions.set(key, session);
    this.live.set(indexKey(session.conversationId, session.kind), key);
  }

  private remove(session: LiveSession): void {
    const key = sessionKey(session.conversationId, session.id);
    this.sessions.delete(key);
    const index = indexKey(session.conversationId, session.kind);
    if (this.live.get(index) === key) this.live.delete(index);
  }

  private touch(session: LiveSession, nowMs: number): void {
    session.updatedAt = nowMs;
  }

  private nextId(): string {
    this.seq += 1;
    return `g${this.seq.toString(36)}`;
  }
}

function seatOf(
  session: TictactoeState | Connect4State | DuelState,
  playerId: string,
): Seat | undefined {
  if (playerId === session.challenger.id) return "challenger";
  if (playerId === session.opponent.id) return "opponent";
  return undefined;
}

function ttl(session: LiveSession): number {
  if (session.kind === "story") return STORY_TTL_MS;
  if ("phase" in session && session.phase === "pending") return CHALLENGE_TTL_MS;
  return PLAY_TTL_MS;
}

function sessionKey(conversationId: string, id: string): string {
  return `${conversationId}:${id}`;
}

function indexKey(conversationId: string, kind: MultiplayerKind): string {
  return `${conversationId}:${kind}`;
}

function clipStory(text: string): string {
  if (text.length <= 500) return text;
  return `…${text.slice(-500)}`;
}
