# Spider rules 1.0

## Deck and deal

- The game uses 104 cards: two 52-card decks with no jokers.
- The tableau has ten columns. The first four receive six cards and the remaining six receive five.
- Only the top card of each initial column is face up.
- Fifty cards remain in stock as five ten-card rounds.
- Suit modes use one, two or four logical suits while preserving 104 unique card identities.

## Moves

- A card may be placed on a card exactly one rank higher, regardless of suit.
- A multi-card run may move only when every card is face up, descending by one rank and the same suit.
- A legal run may move to an empty column.
- Dealing a stock round requires all ten tableau columns to be non-empty.
- A successful tableau move exposes and automatically flips the new top card when it was face down.

## Completed runs

- A face-up, same-suit `K` through `A` run at the top of a column is removed automatically.
- Removing all eight complete runs wins the game.

## Deterministic side effects

- Automatic flip and automatic completion happen in a fixed order after each successful action.
- Invalid actions do not change state, score, timer or undo history.
- Undo restores the exact state before the user action, including automatic effects.
