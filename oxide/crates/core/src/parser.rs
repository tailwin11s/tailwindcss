use bstr::ByteSlice;
use fxhash::FxHashSet;
use tracing::trace;

#[derive(Debug, PartialEq, Eq, Clone)]
pub enum ParseAction<'a> {
    Consume,
    Skip,
    RestartAt(usize),

    SingleCandidate(&'a [u8], Option<usize>),
    MultipleCandidates(Vec<&'a [u8]>, Option<usize>),
    Continue,
    Done,
}

#[derive(Debug, PartialEq, Eq, Clone)]
pub enum Bracketing<'a> {
    Included(&'a [u8]),
    Wrapped(&'a [u8]),
    None,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct SplitCandidate<'a> {
    variant: &'a [u8],
    utility: &'a [u8],
}

#[derive(Default)]
pub struct ExtractorOptions {
    pub preserve_spaces_in_arbitrary: bool,
}

pub struct Extractor<'a> {
    opts: ExtractorOptions,

    input: &'a [u8],
    pos: usize,

    prev: u8,

    idx_start: usize,
    idx_end: usize,
    idx_last: usize,
    idx_arbitrary_start: usize,

    in_arbitrary: bool,
    in_candidate: bool,
    in_escape: bool,

    quote_stack: Vec<u8>,
    bracket_stack: Vec<u8>,
    // buffer: [Option<&'a [u8]>; 8],
}

impl<'a> Extractor<'a> {
    pub fn all(input: &'a [u8], opts: ExtractorOptions) -> Vec<&'a [u8]> {
        Self::new(input, opts).into_iter().flatten().collect()
    }

    pub fn unique(input: &'a [u8], opts: ExtractorOptions) -> FxHashSet<&'a [u8]> {
        let mut candidates: FxHashSet<&[u8]> = Default::default();
        candidates.reserve(100);
        candidates.extend(Self::new(input, opts).into_iter().flatten());
        candidates
    }

    pub fn unique_ord(input: &'a [u8], opts: ExtractorOptions) -> Vec<&'a [u8]> {
        // This is an inefficient way to get an ordered, unique
        // list as a Vec but it is only meant for testing.
        let mut candidates = Self::all(input, opts);
        let mut unique_list = FxHashSet::default();
        unique_list.reserve(candidates.len());
        candidates.retain(|c| unique_list.insert(*c));

        candidates
    }
}

impl<'a> Extractor<'a> {
    pub fn new(input: &'a [u8], opts: ExtractorOptions) -> Self {
        Self {
            opts,
            input,
            pos: 0,
            prev: 0,

            idx_start: 0,
            idx_end: 0,
            idx_arbitrary_start: 0,

            in_arbitrary: false,
            in_candidate: false,
            in_escape: false,

            idx_last: input.len(),
            quote_stack: Vec::with_capacity(8),
            bracket_stack: Vec::with_capacity(8),
            // buffer: [None; 8],
        }
    }
}

/// Helpers
impl<'a> Extractor<'a> {
    #[inline(always)]
    fn in_quotes(&self) -> bool {
        !self.quote_stack.is_empty()
    }

    #[inline(always)]
    fn get_current_candidate(&mut self) -> ParseAction<'a> {
        let mut candidate = &self.input[self.idx_start..=self.idx_end];

        while !candidate.is_empty() {
            // let can_str = std::str::from_utf8(candidate).ok().unwrap();

            let (is_valid, needs_restart) = Extractor::is_valid_candidate_string(candidate);

            if is_valid {
                return ParseAction::SingleCandidate(candidate, None);
            }

            if needs_restart {
                return ParseAction::RestartAt(self.idx_start+1);
            }

            match candidate.split_last() {
                Some((b':' | b'/' | b'.', head)) => {
                    candidate = head;
                }
                _ => break,
            }
        }

        return ParseAction::Continue;
    }

    #[inline(always)]
    fn split_candidate(candidate: &'a [u8]) -> SplitCandidate {
        // [foo:bar]
        // [foo:bar]
        // [.foo_&]:[bar_&]:px-[1]
        // [.foo_&]:md:[bar_&]:px-[1]

        let mut brackets = 0;
        let mut idx_end = 0;

        for n in 0..candidate.len() {
            let c = candidate[n];

            match c {
                b'[' => brackets += 1,
                b']' if brackets > 0 => brackets -= 1,
                b':' if brackets == 0 => idx_end = n + 1,
                _ => {}
            }
        }

        SplitCandidate {
            variant: &candidate[0..idx_end],
            utility: &candidate[idx_end..],
        }
    }

    #[inline(always)]
    fn contains_in_constrained(candidate: &'a [u8], bytes: Vec<u8>) -> bool {
        let mut brackets = 0;

        for n in 0..candidate.len() {
            let c = candidate[n];

            match c {
                b'[' => brackets += 1,
                b']' if brackets > 0 => brackets -= 1,
                _ if brackets == 0 => {
                    if bytes.contains(&c) {
                        return true;
                    }
                }
                _ => {}
            }
        }

        false
    }

    #[inline(always)]
    fn is_valid_candidate_string(candidate: &'a [u8]) -> (bool, bool) {
        let split_candidate = Extractor::split_candidate(candidate);

        let mut offset = 0;
        let utility = &split_candidate.utility;
        let original_utility = &utility;

        // Some special cases that we can ignore while testing the validations.
        if utility.starts_with(b"!-") {
            offset += 2;
        } else if utility.starts_with(b"!") || utility.starts_with(b"-") {
            offset += 1;
        }

        // These are allowed in arbitrary values and in variants but nowhere else
        if Extractor::contains_in_constrained(utility, vec![b'<', b'>']) {
            return (false, true);
        }

        // Pluck out the part that we are interested in.
        let utility = &utility[offset..];

        // Validations
        // We should have _something_
        if utility.is_empty() {
            return (false, false);
        }

        // <sm is fine, but only as a variant
        // TODO: We probably have to ensure that this `:` is not inside the arbitrary values...
        if utility.starts_with(b"<") && !utility.contains(&b':') {
            return (false, false);
        }

        // Only variants can start with a number. E.g.: 2xl is fine, but only as a variant.
        // TODO: Adjust this if we run into issues with actual utilities starting with a number?
        // TODO: We probably have to ensure that this `:` is not inside the arbitrary values...
        if utility[0] >= b'0' && utility[0] <= b'9' && !utility.contains(&b':') {
            return (false, false);
        }

        // In case of an arbitrary property, we should have at least this structure: [a:b]
        if utility.starts_with(b"[") && utility.ends_with(b"]") {
            // [a:b] is at least 5 characters long
            if utility.len() < 5 {
                return (false, false);
            }

            // Should contain a `:`
            if !utility.contains(&b':') {
                return (false, false);
            }

            // Now that we validated that the candidate is technically fine, let's ensure that it
            // doesn't start with a `-` because that would make it invalid for arbitrary properties.
            if original_utility.starts_with(b"-") || original_utility.starts_with(b"!-") {
                return (false, false);
            }

            // The ':` must be preceded by a-Z0-9 because it represents a property name.
            let colon = utility.find(":").unwrap();

            if !utility
                .chars()
                .nth(colon - 1)
                .map_or_else(|| false, |c| c.is_ascii_alphanumeric())
            {
                return (false, false);
            }
        }

        // In case of an arbitrary property, we should not have a modifier of any kind
        if utility.starts_with(b"[") {
            if let Some(first_non_escaped_closing_bracket_idx) =
                utility.char_indices().position(|(s, _, other)| {
                    other == ']'
                        && utility
                            .get((s - 1)..s)
                            .map(|c| !c.eq(b"\\"))
                            .unwrap_or(false)
                })
            {
                if let Some(next) = utility
                    .chars()
                    .nth(first_non_escaped_closing_bracket_idx + 1)
                {
                    // `/` is the indicator for a modifier, this is not allowed after arbitrary
                    // properties
                    if next == '/' {
                        return (false, false);
                    }
                }
            }
        }

        (true, false)
    }

    #[inline(always)]
    fn parse_escaped(&mut self) -> ParseAction<'a> {
        // If this character is escaped, we don't care about it.
        // It gets consumed.
        trace!("Escape::Consume");

        self.in_escape = false;

        ParseAction::Consume
    }

    #[inline(always)]
    fn parse_arbitrary(&mut self, curr: u8, pos: usize) -> ParseAction<'a> {
        // In this we could technically use memchr 6 times (then looped) to find the indexes / bounds of arbitrary valuesq
        if self.in_escape {
            return self.parse_escaped();
        }

        match curr {
            b'\\' => {
                // The `\` character is used to escape characters in arbitrary content _and_ to prevent the starting of arbitrary content
                trace!("Arbitrary::Escape");
                self.in_escape = true;
            }

            // Make sure the brackets are balanced
            b'[' => self.bracket_stack.push(curr),
            b']' => match self.bracket_stack.last() {
                // We've ended a nested bracket
                Some(&last_bracket) if last_bracket == b'[' => {
                    self.bracket_stack.pop();
                }

                // This is the last bracket meaning the end of arbitrary content
                _ if !self.in_quotes() => {
                    trace!("Arbitrary::End\t");
                    self.in_arbitrary = false;

                    if pos - self.idx_arbitrary_start == 1 {
                        // We have an empty arbitrary value, which is not allowed
                        return ParseAction::Skip;
                    }
                }

                // We're probably in quotes or nested brackets, so we keep going
                _ => {}
            },

            // Arbitrary values sometimes contain quotes
            // These can "escape" the arbitrary value mode
            // switching of `[` and `]` characters
            b'"' | b'\'' | b'`' => match self.quote_stack.last() {
                Some(&last_quote) if last_quote == curr => {
                    trace!("Quote::End\t");
                    self.quote_stack.pop();
                }
                _ => {
                    trace!("Quote::Start\t");
                    self.quote_stack.push(curr);
                }
            },

            b' ' if !self.opts.preserve_spaces_in_arbitrary => {
                trace!("Arbitrary::SkipAndEndEarly\t");

                // Restart the parser ahead of the arbitrary value
                // It may pick up more candidates
                return ParseAction::RestartAt(self.idx_arbitrary_start + 1);
            }

            // Arbitrary values allow any character inside them
            // Except spaces unless you are in loose mode
            _ => {
                trace!("Arbitrary::Consume\t");
                // No need to move the end index because either the arbitrary value will end properly OR we'll hit invalid characters
            }
        }

        ParseAction::Consume
    }

    #[inline(always)]
    fn parse_start(&mut self, curr: u8, pos: usize) -> ParseAction<'a> {
        match curr {
            // Enter arbitrary value mode
            b'[' => {
                trace!("Arbitrary::Start\t");
                self.in_arbitrary = true;
                self.idx_arbitrary_start = pos;

                ParseAction::Consume
            }

            // Allowed first characters.
            b'@' | b'!' | b'-' | b'<' | b'>' | b'0'..=b'9' | b'a'..=b'z' | b'A'..=b'Z' => {
                // TODO: A bunch of characters that we currently support but maybe we only want it behind
                // a flag. E.g.: '<sm'
                // | '<' | '>' | '$' | '^' | '_'

                trace!("Candidate::Start\t");

                ParseAction::Consume
            }

            _ => ParseAction::Skip,
        }
    }

    #[inline(always)]
    fn parse_continue(&mut self, prev: u8, curr: u8, pos: usize) -> ParseAction<'a> {
        match curr {
            // Enter arbitrary value mode
            b'[' if prev == b'@'
                || prev == b'-'
                || prev == b' '
                || prev == b':' // Variant separator
                || prev == b'/' // Modifier separator
                || prev == b'!'
                || prev == b'\0' =>
            {
                trace!("Arbitrary::Start\t");
                self.in_arbitrary = true;
                self.idx_arbitrary_start = pos;
            }

            // Can't enter arbitrary value mode
            // This can't be a candidate
            b'[' => {
                trace!("Arbitrary::Skip_Start\t");

                return ParseAction::Skip;
            }

            // Allowed characters in the candidate itself
            // None of these can come after a closing bracket `]`
            b'a'..=b'z'
            | b'A'..=b'Z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            // | b'('
            // | b')'
            | b'<'
            | b'>'
            | b'!'
            | b'@'
            | b'%'
                if prev != b']' =>
            {
                /* TODO: The `b'@'` is necessary for custom separators like _@, maybe we can handle this in a better way... */
                trace!("Candidate::Consume\t");
            }

            // Allowed characters in the candidate itself
            // These MUST NOT appear at the end of the candidate
            b'/' | b':' | b'.' if pos + 1 < self.idx_last => {
                trace!("Candidate::Consume\t");
            }

            _ => return ParseAction::Skip,
        }

        ParseAction::Consume
    }

    #[inline(always)]
    fn can_be_candidate(&mut self, c: u8) -> bool {
        self.in_candidate
            && !self.in_arbitrary
            && (0..=127).contains(&c)
            && (self.idx_start == 0 || self.input[self.idx_start - 1] <= 127)
    }

    #[inline(always)]
    fn handle_skip(&mut self, pos: usize) {
        // In all other cases, we skip characters and reset everything so we can make new candidates
        trace!("Characters::Skip\t");
        self.idx_start = pos;
        self.idx_end = pos;
        self.in_candidate = false;
        self.in_arbitrary = false;
        self.in_escape = false;
    }

    #[inline(always)]
    fn parse_char(&mut self, prev: u8, curr: u8, pos: usize) -> ParseAction<'a> {
        if self.in_arbitrary {
            self.parse_arbitrary(curr, pos)
        } else if self.in_candidate {
            self.parse_continue(prev, curr, pos)
        } else if self.parse_start(curr, pos) == ParseAction::Consume {
            self.in_candidate = true;
            self.idx_start = pos;
            self.idx_end = pos;

            ParseAction::Consume
        } else {
            ParseAction::Skip
        }
    }

    #[inline(always)]
    fn yield_candidate(&mut self, _: usize, curr: u8) -> ParseAction<'a> {
        if self.can_be_candidate(curr) {
            self.get_current_candidate()
        } else {
            ParseAction::Continue
        }
    }

    #[inline(always)]
    fn read(&mut self) -> (usize, u8) {
        if self.pos == self.idx_last {
            return (usize::MAX, 0);
        }

        let r = (self.pos, self.input[self.pos]);
        self.pos += 1;

        r
    }

    #[inline(always)]
    fn restart(&mut self, pos: usize) {
        trace!("Parser::Restart\t{}", pos);

        self.idx_start = pos;
        self.idx_end = pos;
        self.idx_arbitrary_start = 0;

        self.in_arbitrary = false;
        self.in_candidate = false;
        self.in_escape = false;

        self.quote_stack.clear();
        self.bracket_stack.clear();

        self.pos = pos;
        self.prev = *self.input.get(pos - 1).unwrap_or(&0x00);
    }

    #[inline(always)]
    fn without_surrounding(&self) -> Bracketing<'a> {
        let range = self.idx_start..=self.idx_end;
        let clipped = &self.input[range];

        Self::slice_surrounding(clipped)
            .map(|v| Bracketing::Included(v))
            .or_else(
                || {
                    if self.idx_start == 0 || self.idx_end+1 == self.idx_last {
                        return None
                    }

                    let range = self.idx_start-1..=self.idx_end+1;
                    let clipped = &self.input[range];
                    Self::slice_surrounding(clipped).map(|v| Bracketing::Wrapped(v))
                }
            )
            .unwrap_or(Bracketing::None)
    }


    #[inline(always)]
    fn is_balanced(input: &[u8]) -> bool {
        let mut depth = 0isize;

        for n in input {
            match n {
                b'[' | b'{' | b'(' => depth+=1,
                b']' | b'}' | b')' => depth-=1,
                _ => continue,
            }

            if depth < 0 {
                return false
            }
        }

        depth == 0
    }

    #[inline(always)]
    fn slice_surrounding<'i, 'b>(
        input: &'i [u8]
    ) -> Option<&'i [u8]> {
        let mut prev = None;
        let mut input = input;

        // ![foo:bar]

        loop {
            let leading = input.get(0).unwrap_or(&0x00);
            let trailing = input.get(input.len()-1).unwrap_or(&0x00);

            let needed = match (leading, trailing) {
                (b'(', b')') => true,
                (b'{', b'}') => true,
                (b'[', b']') => true,
                _ => false,
            };

            if needed {
                prev = Some(input);
                input = &input[1..input.len()-1];
                continue
            } else if Self::is_balanced(input) && prev.is_some() {
                return Some(input)
            } else {
                return prev
            }
        }
    }

    #[inline(always)]
    fn parse_and_yield(&mut self) -> ParseAction<'a> {
        let (pos, curr) = self.read();
        let action = self.parse_char(self.prev, curr, pos);
        self.prev = curr;

        match action {
            ParseAction::RestartAt(_) => return action,
            ParseAction::Consume => {
                self.idx_end = pos;

                // If we're still consuming characters, we keep going
                // Only exception is if we've hit the end of the input
                if pos + 1 < self.idx_last {
                    return action
                }
            },
            _ => {}
        }

        let action = self.yield_candidate(pos, curr);

        match (&action, curr) {
            (ParseAction::RestartAt(_), _) => action,
            (_, 0x00) => ParseAction::Done,
            (ParseAction::SingleCandidate(candidate, _), _) => self.generate_slices(candidate, pos),
            _ => ParseAction::RestartAt(pos+1),
        }
    }

    #[inline(always)]
    fn generate_slices(&mut self, candidate: &'a [u8], pos: usize) -> ParseAction<'a> {
        // Find all []{}() and `:` positions
        // We also don't split when the []{}() are not at the start/end
        // If the `:` is not inside a []{}() pair we don't split

        // Why is this causing tests to fail when it's not even used?
        // And not mutating anything?
        match self.without_surrounding() {
            Bracketing::None => {
                ParseAction::SingleCandidate(candidate, Some(pos))
            },

            Bracketing::Included(slicable) if slicable == candidate => {
                ParseAction::SingleCandidate(candidate, Some(pos))
            },

            Bracketing::Included(slicable) | Bracketing::Wrapped(slicable) => {
                let mut parts = vec![candidate, slicable];
                parts.extend(slicable.split(|v| v == &b':'));

                let parts = parts.into_iter().filter(|v| !v.is_empty()).collect::<Vec<_>>();

                ParseAction::MultipleCandidates(parts, Some(pos))
            },
        }
    }
}

impl<'a> Iterator for Extractor<'a> {
    type Item = Vec<&'a [u8]>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.pos == self.idx_last {
            return None;
        }

        loop {
            match self.parse_and_yield() {
                ParseAction::Continue => continue,
                ParseAction::SingleCandidate(candidate, pos) => {
                    if let Some(pos) = pos {
                        self.handle_skip(pos);
                    }

                    return Some(vec![candidate])
                },
                ParseAction::MultipleCandidates(candidates, pos) => {
                    if let Some(pos) = pos {
                        self.handle_skip(pos);
                    }
                    return Some(candidates)
                },
                ParseAction::Done => return None,

                ParseAction::Skip => continue,
                ParseAction::Consume => continue,
                ParseAction::RestartAt(pos) => self.restart(pos),
            }
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;

    fn _please_trace() {
        tracing_subscriber::fmt()
            .with_max_level(tracing::Level::TRACE)
            .with_span_events(tracing_subscriber::fmt::format::FmtSpan::ACTIVE)
            .compact()
            .init();
    }

    fn run(input: &str, loose: bool) -> Vec<&str> {
        Extractor::unique_ord(
            input.as_bytes(),
            ExtractorOptions {
                preserve_spaces_in_arbitrary: loose,
            },
        )
        .into_iter()
        .map(|s| unsafe { std::str::from_utf8_unchecked(s) })
        .collect()
    }

    #[test]
    fn it_can_parse_simple_candidates() {
        let candidates = run("underline", false);
        assert_eq!(candidates, vec!["underline"]);
    }

    #[test]
    fn it_can_parse_multiple_simple_utilities() {
        let candidates = run("font-bold underline", false);
        assert_eq!(candidates, vec!["font-bold", "underline"]);
    }

    #[test]
    fn it_can_parse_simple_candidates_with_variants() {
        let candidates = run("hover:underline", false);
        assert_eq!(candidates, vec!["hover:underline"]);
    }

    #[test]
    fn it_can_parse_simple_candidates_with_stacked_variants() {
        let candidates = run("focus:hover:underline", false);
        assert_eq!(candidates, vec!["focus:hover:underline"]);
    }

    #[test]
    fn it_can_parse_utilities_with_arbitrary_values() {
        let candidates = run("m-[2px]", false);
        assert_eq!(candidates, vec!["m-[2px]"]);
    }

    #[test]
    fn it_can_parse_utilities_with_arbitrary_values_and_variants() {
        let candidates = run("hover:m-[2px]", false);
        assert_eq!(candidates, vec!["hover:m-[2px]"]);
    }

    #[test]
    fn it_can_parse_arbitrary_variants() {
        let candidates = run("[@media(min-width:200px)]:underline", false);
        assert_eq!(candidates, vec!["[@media(min-width:200px)]:underline"]);
    }

    #[test]
    fn it_can_parse_matched_variants() {
        let candidates = run("group-[&:hover]:underline", false);
        assert_eq!(candidates, vec!["group-[&:hover]:underline"]);
    }

    #[test]
    fn it_should_not_keep_spaces() {
        let candidates = run("bg-[rgba(0, 0, 0)]", false);

        assert_eq!(candidates, vec!["rgba"]);
    }

    #[test]
    fn it_should_keep_spaces_in_loose_mode() {
        let candidates = run("bg-[rgba(0, 0, 0)]", true);
        assert_eq!(candidates, vec!["bg-[rgba(0, 0, 0)]"]);
    }

    #[test]
    fn it_should_keep_important_arbitrary_properties() {
        let candidates = run("![foo:bar]", false);
        assert_eq!(candidates, vec!["![foo:bar]"]);
    }

    #[test]
    fn it_should_not_allow_for_bogus_candidates() {
        let candidates = run("[0]", false);
        assert!(candidates.is_empty());

        let candidates = run("[something]", false);
        assert!(candidates.is_empty());

        let candidates = run("[color:red]/dark", false);
        assert!(candidates.is_empty());

        let candidates = run("[color:red]/[0.5]", false);
        assert!(candidates.is_empty());

        let candidates = run(" [feature(slice_as_chunks)]", false);
        assert!(candidates.is_empty());

        let candidates = run("![feature(slice_as_chunks)]", false);
        assert!(candidates.is_empty());

        let candidates = run("-[feature(slice_as_chunks)]", false);
        assert!(candidates.is_empty());

        let candidates = run("!-[feature(slice_as_chunks)]", false);
        assert!(candidates.is_empty());

        let candidates = run("-[foo:bar]", false);
        assert!(candidates.is_empty());

        let candidates = run("!-[foo:bar]", false);
        assert!(candidates.is_empty());
    }

    #[test]
    fn it_should_keep_candidates_with_brackets_in_arbitrary_values_inside_quotes() {
        let candidates = run("content-['hello_[_]_world']", false);
        assert_eq!(candidates, vec!["content-['hello_[_]_world']"]);
    }

    #[test]
    fn it_should_ignore_leading_spaces() {
        let candidates = run("        backdrop-filter-none", false);
        assert_eq!(candidates, vec!["backdrop-filter-none"]);
    }

    #[test]
    fn it_should_ignore_trailing_spaces() {
        let candidates = run("backdrop-filter-none        ", false);
        assert_eq!(candidates, vec!["backdrop-filter-none"]);
    }

    #[test]
    fn it_should_keep_classes_before_an_ending_newline() {
        let candidates = run("backdrop-filter-none\n", false);
        assert_eq!(candidates, vec!["backdrop-filter-none"]);
    }

    #[test]
    fn it_should_parse_out_the_correct_classes_from_tailwind_tests() {
        // From: tests/arbitrary-variants.test.js
        let candidates = run(
            r#"
                <div class="dark:lg:hover:[&>*]:underline"></div>

                <div class="[&_.foo\_\_bar]:hover:underline"></div>
                <div class="hover:[&_.foo\_\_bar]:underline"></div>
            "#,
            false,
        );
        // TODO: it should not include additional (separate) classes: class, hover:, foo: bar, underline
        // TODO: Double check the expectations based on above information
        assert_eq!(
            candidates,
            vec![
                "div",
                "class",
                r#"dark:lg:hover:[&>*]:underline"#,
                r#"[&_.foo\_\_bar]:hover:underline"#,
                r#"hover:[&_.foo\_\_bar]:underline"#
            ]
        );
    }

    #[test]
    fn potential_candidates_are_skipped_when_hitting_impossible_characters() {
        let candidates = run("        <p class=\"text-sm text-blue-700\">A new software update is available. See what’s new in version 2.0.4.</p>", false);
        assert_eq!(
            candidates,
            vec![
                "p",
                "class",
                "text-sm",
                "text-blue-700",
                "A",
                "new",
                "software",
                "update",
                "is",
                "available.",
                "See",
                // "what", // what is dropped because it is followed by the fancy: ’
                // "s",    // s is dropped because it is preceeded by the fancy: ’
                // "new", // Already seen
                "in",
                "version",
            ]
        );
    }

    #[test]
    fn ignores_arbitrary_property_ish_things() {
        let candidates = run(" [feature(slice_as_chunks)]", false);
        assert!(candidates.is_empty());
    }

    #[test]
    fn foo_bar() {
        // w[…] is not a valid pattern for part of candidate
        // but @[] is (specifically in the context of a variant)

        let candidates = run("%w[text-[#bada55]]", false);
        assert_eq!(candidates, vec!["w", "text-[#bada55]"]);
    }

    #[test]
    fn crash_001() {
        let candidates = run("Aҿɿ[~5", false);
        assert!(candidates.is_empty());
    }

    #[test]
    fn crash_002() {
        let candidates = run("", false);
        assert!(candidates.is_empty());
    }

    #[test]
    fn bad_001() {
        let candidates = run("[杛杛]/", false);
        assert!(candidates.is_empty())
    }

    #[test]
    fn bad_002() {
        let candidates = run(r"[\]\\\:[]", false);
        assert!(candidates.is_empty());
    }

    #[test]
    fn bad_003() {
        let candidates = run(r"[𕤵:]", false);
        assert!(candidates.is_empty());
    }

    #[test]
    fn classes_in_js_arrays() {
        let candidates = run(
            r#"let classes = ['bg-black', 'hover:px-0.5', 'text-[13px]', '[--my-var:1_/_2]', '[.foo_&]:px-[0]', '[.foo_&]:[color:red]']">"#,
            false,
        );
        assert_eq!(
            candidates,
            vec![
                "let",
                "classes",
                "bg-black",
                "hover:px-0.5",
                "text-[13px]",
                "[--my-var:1_/_2]",
                "--my-var:1_/_2",
                "--my-var",
                "1_/_2",
                "[.foo_&]:px-[0]",
                "[.foo_&]:[color:red]",
            ]
        );
    }

    #[test]
    fn classes_as_object_keys() {
        let candidates = run(
            r#"<div :class="{ underline: isActive, 'px-1.5': isOnline }"></div>"#,
            false,
        );
        assert_eq!(
            candidates,
            vec!["div", "class", "underline", "isActive", "px-1.5", "isOnline"]
        );
    }

    #[test]
    fn multiple_nested_candidates() {
        let candidates = run(
            r#"{color:red}"#,
            false,
        );
        assert_eq!(
            candidates,
            vec!["color:red", "color", "red"]
        );
    }

    #[test]
    fn wipit_wipit_good() {
        let result = Extractor::slice_surrounding(&b".foo_&]:px-[0"[..]).map(std::str::from_utf8).transpose().unwrap();
        assert_eq!(result, None);

        let result = Extractor::slice_surrounding(&b"[.foo_&]:px-[0]"[..]).map(std::str::from_utf8).transpose().unwrap();
        assert_eq!(result, Some("[.foo_&]:px-[0]"));

        let result = Extractor::slice_surrounding(&b"{[.foo_&]:px-[0]}"[..]).map(std::str::from_utf8).transpose().unwrap();
        assert_eq!(result, Some("[.foo_&]:px-[0]"));

        let result = Extractor::slice_surrounding(&b"![foo:bar]"[..]).map(std::str::from_utf8).transpose().unwrap();
        assert_eq!(result, None);

        // 0.19s in a release build:
        let count = 1_000;
        let crazy = format!("{}[.foo_&]:px-[0]{}", "[".repeat(count), "]".repeat(count));

        let result = Extractor::slice_surrounding(&crazy.as_bytes()).map(std::str::from_utf8).transpose().unwrap();
        assert_eq!(result, Some("[.foo_&]:px-[0]"));
    }
}
