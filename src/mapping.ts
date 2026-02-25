import { BigInt } from "@graphprotocol/graph-ts";
import { PlayerWonTournament } from "../generated/TournamentDiamond/TournamentDiamond";
import { Player, TournamentWin } from "../generated/schema";

export function handlePlayerWonTournament(event: PlayerWonTournament): void {
  // Winner wallet
  const playerId = event.params.player.toHexString().toLowerCase();
  let player = Player.load(playerId);

  if (player == null) {
    player = new Player(playerId);
    player.tournamentWins = BigInt.zero();
    // player.name stays null until Profiles events fill it
  }

  player.tournamentWins = player.tournamentWins.plus(BigInt.fromI32(1));
  player.save();

  // Unique event id: txHash-logIndex
  const winId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  const win = new TournamentWin(winId);

  win.tournamentId = event.params.tournamentId;
  win.player = playerId;
  win.value = event.params.value;
  win.timestamp = event.block.timestamp;
  win.blockNumber = event.block.number;

  win.save();
}