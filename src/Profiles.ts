import { BigInt } from "@graphprotocol/graph-ts";
import { ProfileCreated, ProfileUpdated } from "../generated/Profiles/Profiles";
import { Player } from "../generated/schema";

function upsertPlayerName(ownerHex: string, name: string): void {
  const id = ownerHex.toLowerCase();
  let p = Player.load(id);

  if (p == null) {
    p = new Player(id);
    p.tournamentWins = BigInt.zero();
  }

  // Store latest on-chain name
  p.name = name;
  p.save();
}

export function handleProfileCreated(event: ProfileCreated): void {
  upsertPlayerName(event.params.owner.toHexString(), event.params.name);
}

export function handleProfileUpdated(event: ProfileUpdated): void {
  upsertPlayerName(event.params.owner.toHexString(), event.params.name);
}