use std::io::{self, BufRead};
use solver_core::common::card::Card;
use solver_core::SpiderEngine;

fn main() {
    for line in io::stdin().lock().lines() {
        let line = match line { Ok(value) => value, Err(error) => { eprintln!("stdin: {error}"); break; } };
        let fields: Vec<&str> = line.trim().split('\t').collect();
        if fields.len() != 3 { println!("?\tERROR\tbad_input"); continue; }
        let id = fields[0];
        let suit_count: u32 = match fields[1].parse() { Ok(value @ (1 | 2 | 4)) => value, _ => { println!("{id}\tERROR\tbad_suit"); continue; } };
        let bytes = match decode_hex(fields[2]) { Ok(value) => value, Err(error) => { println!("{id}\tERROR\t{error}"); continue; } };
        let deck: Option<Vec<Card>> = bytes.into_iter().map(Card::decode).collect();
        let Some(deck) = deck else { println!("{id}\tERROR\tbad_card"); continue; };
        if deck.len() != 104 { println!("{id}\tERROR\tbad_count"); continue; }
        let engine = SpiderEngine::new(suit_count);
        let board = match engine.deal(deck) { Ok(value) => value, Err(_) => { println!("{id}\tERROR\tdeal_failed"); continue; } };
        let moves = engine.solve(&board, false);
        match moves {
            Some(moves) => {
                let checkpoints = engine.last_checkpoints_adopted();
                let encoded = moves.iter().map(|m| {
                    if m.move_type == "dealFromStock" { "D".to_owned() }
                    else { format!("M,{},{},{}", m.source, m.destination, m.card_count) }
                }).collect::<Vec<_>>().join(";");
                println!("{id}\tSOLVED\t{checkpoints}\t{encoded}");
            }
            None => println!("{id}\tUNSOLVED\t0\t"),
        }
    }
}

fn decode_hex(value: &str) -> Result<Vec<u8>, &'static str> {
    if value.len() % 2 != 0 { return Err("bad_hex"); }
    (0..value.len()).step_by(2).map(|index| u8::from_str_radix(&value[index..index+2], 16).map_err(|_| "bad_hex")).collect()
}
