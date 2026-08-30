import type { Socket } from 'socket.io';
import type { VisualWorldBootstrap } from '../bot/adapter/VisualWorldSource.js';
import type { VisualWorldDeltaBatch } from './visualWorldDeltaBatcher.js';

export const VISUAL_WORLD_BOOTSTRAP_START_EVENT = 'bot:v2:visualWorld:bootstrap:start';
export const VISUAL_WORLD_BOOTSTRAP_SECTION_EVENT = 'bot:v2:visualWorld:bootstrap:section';
export const VISUAL_WORLD_BOOTSTRAP_END_EVENT = 'bot:v2:visualWorld:bootstrap:end';
export const VISUAL_WORLD_DELTA_EVENT = 'bot:v2:visualWorld:delta';
export const VISUAL_WORLD_DELTA_START_EVENT = 'bot:v2:visualWorld:delta:start';
export const VISUAL_WORLD_DELTA_SECTION_EVENT = 'bot:v2:visualWorld:delta:section';
export const VISUAL_WORLD_DELTA_END_EVENT = 'bot:v2:visualWorld:delta:end';

/**
 * One VisualSection contains four binary arrays. Emitting the complete snapshot as
 * one Socket.IO packet exceeds the browser decoder's attachment limit as soon as
 * the snapshot contains three sections. Keep each section in its own packet.
 */
export function emitVisualWorldBootstrap(
  socket: Pick<Socket, 'emit'>,
  botId: string,
  bootstrap: VisualWorldBootstrap,
): void {
  const { sections, ...metadata } = bootstrap;
  const identity = {
    botId,
    sessionId: bootstrap.sessionId,
    generation: bootstrap.generation,
  };

  socket.emit(VISUAL_WORLD_BOOTSTRAP_START_EVENT, {
    ...identity,
    bootstrap: metadata,
    sectionCount: sections.length,
  });
  sections.forEach((section, index) => {
    socket.emit(VISUAL_WORLD_BOOTSTRAP_SECTION_EVENT, {
      ...identity,
      index,
      section,
    });
  });
  socket.emit(VISUAL_WORLD_BOOTSTRAP_END_EVENT, {
    ...identity,
    sectionCount: sections.length,
  });
}

export function emitVisualWorldDeltaBatch(
  socket: Pick<Socket, 'emit'>,
  botId: string,
  batch: VisualWorldDeltaBatch,
): void {
  const sectionFragments = batch.deltas.flatMap((delta, deltaIndex) => delta.kind === 'column_replace'
    ? delta.sections.map((section, sectionIndex) => ({ deltaIndex, sectionIndex, section }))
    : []);
  if (sectionFragments.length === 0) {
    socket.emit(VISUAL_WORLD_DELTA_EVENT, { botId, batch });
    return;
  }

  const wireDeltas = batch.deltas.map(delta => delta.kind === 'column_replace'
    ? { ...delta, sections: [], sectionCount: delta.sections.length }
    : delta);
  const identity = {
    botId,
    sessionId: batch.sessionId,
    generation: batch.generation,
    fromSequence: batch.fromSequence,
    toSequence: batch.toSequence,
  };
  socket.emit(VISUAL_WORLD_DELTA_START_EVENT, {
    ...identity,
    batch: { ...batch, deltas: wireDeltas },
    sectionCount: sectionFragments.length,
  });
  sectionFragments.forEach(({ deltaIndex, sectionIndex, section }, index) => {
    socket.emit(VISUAL_WORLD_DELTA_SECTION_EVENT, {
      ...identity,
      index,
      deltaIndex,
      sectionIndex,
      section,
    });
  });
  socket.emit(VISUAL_WORLD_DELTA_END_EVENT, {
    ...identity,
    sectionCount: sectionFragments.length,
  });
}
