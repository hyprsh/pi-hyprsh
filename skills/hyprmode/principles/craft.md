# Craft principles

## Laziness protocol

The best change is the one you do not have to make. Before adding a layer, an
abstraction or a parameter, check whether deleting something achieves the same
end. Code that does not exist has no bugs, needs no tests and confuses nobody.

Applies when: sizing a diff, or when you catch yourself threading a value
through three functions to reach a fourth.

The test: could a reviewer ask "why is this here?" and get an answer shorter
than the code? If not, it has not earned its place.

## Subtract before you add

When a change lands on top of accumulated weight, remove the weight first, then
build on the simpler base. Redundant validators, stub references, dead branches,
a config option nobody sets. Doing this first often shrinks the change you came
to make, sometimes to nothing.

Applies when: sequencing an addition, a refactor or a rewrite.

## Minimise reader load

Optimise for the person who has to answer a question about this code at 3am
with no context. Count the hops between the question and the answer, and the
amount of state they must hold in their head to follow it.

Concretely: collapse a wrapper with one caller, shrink the scope of anything
mutable, prefer a longer obvious function to three short clever ones, and put
the thing that varies next to the thing it varies with.

Applies when: reviewing, or when tracing code is taking longer than it should.

## Build the lever

For anything repetitive or wide, write the tool that does it or proves it —
a script, a codemod, a check — instead of doing it by hand. The tool is the
artifact: a reviewer can rerun it, and it does not get bored on the fortieth
file the way you do on the fourth.

Applies when: an edit repeats across many sites, or a claim needs to hold
everywhere rather than in the three places you sampled.

The test: if you did it by hand, could anyone confirm you did it consistently?

## Encode lessons in structure

The second time you write the same instruction, stop writing instructions. Turn
it into something the machine enforces: a type that makes the mistake
unrepresentable, a lint, a runtime check, a required field, a test.

Prose is a rule everyone can skip. Structure is a rule nobody can.

Applies when: you are repeating guidance, or you just fixed a bug someone will
reintroduce.
