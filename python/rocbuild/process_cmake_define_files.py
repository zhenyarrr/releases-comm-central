# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import argparse
import os
import re
import sys

from mozbuild.backend.configenvironment import PartialConfigEnvironment

from buildconfig import topobjdir


def define_type(string):
    vals = string.split("=", 1)
    if len(vals) == 1:
        vals.append(1)
    elif vals[1].isdecimal():
        vals[1] = int(vals[1])
    return tuple(vals)


def process_cmake_define_file(output, input_file, extra_defines):
    """Creates the given config header. A config header is generated by
    taking the corresponding source file and replacing some #define/#undef
    occurrences:
        "#undef NAME" is turned into "#define NAME VALUE"
        "#cmakedefine NAME" is turned into "#define NAME VALUE"
        "#define NAME" is unchanged
        "#define NAME ORIGINAL_VALUE" is turned into "#define NAME VALUE"
        "#undef UNKNOWN_NAME" is turned into "/* #undef UNKNOWN_NAME */"
        "#cmakedefine UNKNOWN_NAME" is turned into "/* #undef UNKNOWN_NAME */"
        Whitespaces are preserved.
    """

    path = os.path.abspath(input_file)

    config = PartialConfigEnvironment(topobjdir)

    defines = dict(config.defines.iteritems())
    defines.update(extra_defines)

    with open(path, "r") as input_file:
        r = re.compile(
            r'^\s*#\s*(?P<cmd>[a-z]+)(?:\s+(?P<name>\S+)(?:\s+(?P<value>("[^"]+"|\S+)))?)?',
            re.U,
        )
        for line in input_file:
            m = r.match(line)
            if m:
                cmd = m.group("cmd")
                name = m.group("name")
                value = m.group("value")
                if name:
                    if cmd == "define":
                        if value and name in defines:
                            line = (
                                line[: m.start("value")]
                                + str(defines[name])
                                + line[m.end("value") :]
                            )
                    elif cmd in ("undef", "cmakedefine"):
                        if name in defines:
                            line = (
                                line[: m.start("cmd")]
                                + "define"
                                + line[m.end("cmd") : m.end("name")]
                                + " "
                                + str(defines[name])
                                + line[m.end("name") :]
                            )
                        else:
                            line = (
                                "/* #undef "
                                + line[m.start("name") : m.end("name")]
                                + " */"
                                + line[m.end("name") :]
                            )

            output.write(line)


def main(output, *argv):
    parser = argparse.ArgumentParser(description="Process define files.")

    parser.add_argument("input", help="Input define file.")
    parser.add_argument(
        "-D",
        type=define_type,
        action="append",
        dest="extra_defines",
        default=[],
        help="Additional defines not set at configure time.",
    )

    args = parser.parse_args(argv)

    return process_cmake_define_file(output, args.input, args.extra_defines)


if __name__ == "__main__":
    sys.exit(main(*sys.argv))
