"""The job acquisition and application engine.

Sources fan in, one canonical record fans out:

    sources/*  ->  normalize  ->  dedupe  ->  score  ->  route  ->  apply
                                     |                              |
                                   store  <---- application_events -+

Each stage is a pure function of its input wherever it can be, so the parts
that decide *what* to apply to are testable without a browser, a network, or
a database.
"""
