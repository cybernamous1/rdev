---
id: fx-alpha
kind: lesson
title: Fixture alpha: counting widgets
path: Luau Programming
category: Fixture
level: Beginner
minutes: 3
order: 1
summary: Synthetic fixture entry used only by automated tests. Fixture alpha: counting widgets.
tags: [fixture, alpha]
objectives:
  - Exercise the pipeline with Fixture alpha: counting widgets
sources:
  - fx-source-a
updated: 2026-11-22
---
Alpha explains how a purely invented widget counter works in a fictional workshop.

```luau
local function fixture1()
    return "fx-alpha"
end
print(fixture1())
```

## Try it yourself
Count three imaginary widgets and print the total.
