# Prototype

A throwaway sketch that settles a question by observation instead of argument.

Reach for this when you are about to ask the user "which approach" or "how
should this behave", and the answer is something you could find out by running
something. Behaviour, timing, layout, output, whether a library can do the
thing: none of that is the user's to answer. The ask is the slow path.

1. **Write the question as a prediction.** "If I do X, Y will happen." A
   question you cannot phrase this way is a preference, not an experiment —
   take it to the user instead.
2. **Decide what result would change your mind,** before you run it. Otherwise
   you will read the outcome as confirming whatever you already preferred.
3. **Build the smallest thing that answers it.** Throwaway quality, in a scratch
   directory or a temp file, outside the source tree. It is an instrument, not
   a contribution.
4. **Run it and record the actual output.** Not the summary, the output.
5. **Answer the question,** and say plainly if the result was inconclusive.
6. **Delete the prototype,** or say where you left it and why.
7. **Then start the real work** with the fork settled, under whichever playbook
   actually fits.

Two competing sketches beat one when the decision is architectural and hard to
reverse. Build both, compare them side by side, and keep neither.

The reply states the question, the experiment, the observed result, and the
decision it settled.
